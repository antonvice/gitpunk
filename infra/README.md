# Infrastructure templates

Kafka development config follows Apache's single-broker Docker quickstart. Local loopback only; no production availability/security claim. Container recreation can lose broker data; Gitpunk's durable outbox must support replay.

```sh
docker compose -f infra/compose.yaml up -d
docker compose -f infra/compose.yaml exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic gitpunk.events.v1 --partitions 1 --replication-factor 1
```

For a local smoke check, produce a test record with `kafka-console-producer.sh`, then read it with `kafka-console-consumer.sh --from-beginning --max-messages 1`. Broker start and live producer → consumer round trip were verified on this Mac. The broker is development-only and bound to loopback; see `.local/kafka-smoke.json` for the local receipt.

`npm run demo:kafka-recovery` temporarily stops/restarts this project's broker. It proves HTTP acceptance/replay while Kafka is down, pending delivery across a server restart and independent consumer receipt after recovery. Accepted events remain single records; Kafka delivery is at least once.

`checks.example.json` is trusted administrator configuration. Pull its exact image, then run `npm run demo:checks` or `npm run test:docker`. Tests use read-only exact Git source, nonroot execution, no network/credentials and disposable databases. Manual approval is the default; the scripted demo explicitly uses automatic approval.

The [Artifacts bridge](../server/cloudflare/README.md) is runnable Worker code with mocked binding tests and a successful deployment dry run. `npm run build:cloudflare` verifies its bundle. Live deployment/provisioning still requires Cloudflare login; the local coordinator continues to use bare Git.

`server/wrangler.example.jsonc` remains the future full-server binding template. Its D1/R2/branch coordinator entrypoint is not implemented. The bridge has its own smaller config at `server/cloudflare/wrangler.example.jsonc`.

Production additionally needs a TLS/authenticated Kafka service, gateway hosting, isolated runners, secrets, backups and event subscription provisioning. These are not silently created by this setup.

[Kafka quickstart](https://kafka.apache.org/quickstart/) · [Artifacts Workers setup](https://developers.cloudflare.com/artifacts/get-started/workers/)
