// async_utils.cpp — Cross-platform async function examples.
// These work on both iOS and Android.

#include "Nativ.h"
#include <string>
#include <thread>
#include <chrono>

NATIV_EXPORT(async)
std::string slowGreetCpp(const std::string& name) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    return "Hello " + name + " (after 1s, from C++)!";
}

NATIV_EXPORT(async)
int heavyComputeCpp(int n) {
    if (n <= 1) return n;
    int a = 0, b = 1;
    for (int i = 2; i <= n; i++) {
        int tmp = a + b;
        a = b;
        b = tmp;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    return b;
}
