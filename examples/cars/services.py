"""The baseline service contract uses the Car model."""
from models import Car

def create_car(identifier: int, name: str) -> Car:
    return Car(identifier, name)
