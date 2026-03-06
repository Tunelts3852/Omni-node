def print_gugudan(start: int = 1, end: int = 9) -> None:
    for dan in range(start, end + 1):
        for i in range(1, 10):
            print(f"{dan} x {i} = {dan * i}")
        print()


if __name__ == "__main__":
    print_gugudan()