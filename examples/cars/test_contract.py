"""Owner-defined baseline contracts used by the isolated collaboration demo."""
import os
import sqlite3
import tempfile
import unittest

from services import create_car


class CarContract(unittest.TestCase):
    def test_creation_preserves_identity_and_name(self):
        car = create_car(7, "Roadster")
        self.assertEqual(car.id, 7)
        self.assertEqual(car.name, "Roadster")

    def test_disposable_database(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR", "/tmp")) as root:
            with sqlite3.connect(os.path.join(root, "cars.sqlite")) as db:
                db.execute("CREATE TABLE cars (id INTEGER, name TEXT)")
                db.execute("INSERT INTO cars VALUES (?, ?)", (7, "Roadster"))
                self.assertEqual(db.execute("SELECT name FROM cars WHERE id=7").fetchone()[0], "Roadster")


if __name__ == "__main__":
    unittest.main()
