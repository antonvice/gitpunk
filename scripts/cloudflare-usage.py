#!/usr/bin/env python3
"""One-shot, read-only usage snapshot; missing permissions/data remain unknown."""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import tempfile
import tomllib
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / '.local/cloudflare'
UNKNOWN = lambda reason: {'status': 'unknown', 'reason': reason}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def bounded_file(path, private=False):
    path = Path(path).expanduser()
    if private and (path.stat().st_mode & 0o077 or path.stat().st_uid != os.getuid()):
        raise ValueError('unprotected credential file')
    with path.open('rb') as file:
        data = file.read(262_145)
    if len(data) > 262_144:
        raise ValueError('oversized configuration')
    return data


def api(path, token, payload=None):
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/' + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=10) as response:
            body = response.read(1_048_577)
        if len(body) > 1_048_576:
            return UNKNOWN('response_too_large')
        data = json.loads(body)
        return data if isinstance(data, dict) else UNKNOWN('unexpected_schema')
    except urllib.error.HTTPError as error:
        return UNKNOWN('permission_or_auth' if error.code in (401, 403) else f'http_{error.code}')
    except Exception:
        return UNKNOWN('network_or_invalid_response')


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('missing timezone')
    return parsed.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def billing(data):
    if data.get('status') == 'unknown':
        return data
    rows = data.get('result')
    if data.get('success') is not True or data.get('errors') or not isinstance(rows, list):
        return UNKNOWN('permission_or_unexpected_schema')
    if not rows:
        return UNKNOWN('no_reported_usage_yet')
    try:
        if any(row.get('BillingCurrency') != 'USD' or row.get('ChargeCategory') != 'Usage' or not number(row.get('ContractedCost')) for row in rows):
            return UNKNOWN('unexpected_currency_or_schema')
        cost = sum(row['ContractedCost'] for row in rows)
        if not number(cost):
            return UNKNOWN('unexpected_cost')
        return {'status': 'reported_delayed', 'usage_overage_usd': round(cost, 8),
            'period_starts': sorted({timestamp(row['BillingPeriodStart']) for row in rows}),
            'reported_through': max(timestamp(row['ChargePeriodEnd']) for row in rows)}
    except Exception:
        return UNKNOWN('unexpected_schema')


def counts(data, field, metric):
    if data.get('status') == 'unknown':
        return data
    try:
        if data.get('errors') or len(data['data']['viewer']['accounts']) != 1:
            return UNKNOWN('permission_or_unsupported_schema')
        account = data['data']['viewer']['accounts'][0]
        result = {'status': 'reported_analytics_not_invoice'}
        for scope in ('account', 'project'):
            rows = account[scope]
            value = rows[0]['sum'][metric] if field == 'workers' and len(rows) == 1 else rows[0]['count'] if field == 'artifacts' and len(rows) == 1 else None
            result[scope + '_' + metric] = value if number(value) else None
        return result if all(result[key] is not None for key in result if key != 'status') else {**result, 'status': 'partial', 'reason': 'empty_or_unreported_activity'}
    except Exception:
        return UNKNOWN('permission_or_unsupported_schema')


def main():
    now = dt.datetime.now(dt.timezone.utc)
    output = {'checked_at': now.isoformat().replace('+00:00', 'Z'), 'hard_spend_cap': False,
        'all_costs_verified': False, 'workers_cpu_ms': None,
        'subscription_fees_included': False, 'artifacts_storage_bytes': None,
        'note': 'Delayed account usage includes other projects; analytics are not an invoice or spending cap.'}
    try:
        config = json.loads(bounded_file(DIRECTORY / 'wrangler.json'))
        account, worker, namespace = config['account_id'], config['name'], config['artifacts'][0]['namespace']
        if not re.fullmatch('[a-f0-9]{32}', account) or not all(re.fullmatch('[a-zA-Z0-9_.-]{1,64}', value) for value in (worker, namespace)):
            raise ValueError('invalid account or resource')
        local = json.loads(bounded_file(DIRECTORY / 'usage-config.json', True)) if (DIRECTORY / 'usage-config.json').exists() else {}
        token = bounded_file(ROOT / Path(local['token_file']).expanduser(), True).decode().strip() if local.get('token_file') else tomllib.loads(bounded_file(Path.home() / 'Library/Preferences/.wrangler/config/default.toml', True).decode())['oauth_token']
        if not isinstance(token, str) or not 20 <= len(token) <= 4096 or re.search(r'\s', token):
            raise ValueError('invalid credential')
    except Exception:
        output['status'] = 'unknown'; output['reason'] = 'configuration_or_credentials_unavailable'
    else:
        output['billing'] = billing(api(f'accounts/{account}/billable-usage', token))
        info = api(f'accounts/{account}/billable-usage/info', token)
        try:
            if info.get('errors') or info.get('success') is not True:
                raise ValueError('unsupported info')
            anchors = sorted({timestamp(row['billing_cycle_anchor_timestamp']) for row in info['result']['subscriptions']})
            output['billing_cycle'] = {'status': 'reported' if anchors else 'unknown', 'anchors': anchors}
        except Exception:
            output['billing_cycle'] = info if info.get('status') == 'unknown' else UNKNOWN('permission_or_unexpected_schema')
        starts = output['billing'].get('period_starts', [])
        start = max(timestamp((now - dt.timedelta(days=30)).isoformat()), min(starts)) if starts else timestamp((now - dt.timedelta(days=1)).isoformat())
        end = timestamp(now.isoformat())
        output['analytics_window'] = {'start': start, 'end': end, 'scope': 'reported_billing_period_bounded_to_30_days' if starts else 'last_24_hours_billing_period_unknown'}
        filters = 'datetime_geq:' + json.dumps(start) + ',datetime_leq:' + json.dumps(end)
        for kind, dataset, selector, selected, metric in [('workers', 'workersInvocationsAdaptive', 'scriptName', worker, 'requests'), ('artifacts', 'artifactsEventsAdaptiveGroups', 'repositoryNamespace', namespace, 'events')]:
            fields = 'sum{requests}' if kind == 'workers' else 'count'
            query = 'query{viewer{accounts(filter:{accountTag:' + json.dumps(account) + '}){account:' + dataset + '(limit:1,filter:{' + filters + '}){' + fields + '} project:' + dataset + '(limit:1,filter:{' + filters + ',' + selector + ':' + json.dumps(selected) + '}){' + fields + '}}}}'
            output[kind] = counts(api('graphql', token, {'query': query}), kind, metric)
        output['status'] = 'reported_snapshot' if output['billing'].get('status') == 'reported_delayed' and all(output[kind].get('status') == 'reported_analytics_not_invoice' for kind in ('workers', 'artifacts')) else 'partial_or_unknown'
    result = json.dumps(output, indent=2, allow_nan=False) + '\n'
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=DIRECTORY, delete=False) as file:
        file.write(result)
    os.replace(file.name, DIRECTORY / 'usage.json')
    print(result, end='')
    return 0 if output['status'] == 'reported_snapshot' else 2


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    raise SystemExit(main())
