// rust_math.rs — Rust functions exported to JavaScript
//
// Same pattern as math_utils.cpp but in Rust.
// Edit and save — hot-reloads on device.

#[function(sync)]
pub fn fibonacci(n: i32) -> i32 {
    if n <= 1 { return n; }
    let mut a = 0i32;
    let mut b = 1i32;
    for _ in 2..=n  {
        let tmp = a + b;
        a = b;
        b = tmp;
    }
    b
}

#[function(sync)]
pub fn is_prime(n: i32) -> bool {
    if n <= 1 { return false; }
    if n <= 3 { return true; }
    if n % 2 == 0 || n % 3 == 0 { return false; }
    let mut i = 5;
    while i * i <= n {
        if n % i == 0 || n % (i + 2) == 0 { return false; }
        i += 6;
    }
    true
}

#[function(sync)]
pub fn greet_rust(name: String) -> String {
    format!("Hoo {}, from Rust!", name)
}
