// math_utils.cpp — PoC C++ functions exported to JavaScript
// Demonstrates NATIV_EXPORT for sync and async functions.


#include "Nativ.h"
#include <string>

NATIV_EXPORT(sync)
int add(int a, int b) {
    return a + b;
}

NATIV_EXPORT(sync)
double fast_inv_sqrt(double x) {
    // Classic Quake III approximation (for fun)
    float xf = static_cast<float>(x);
    float xhalf = 0.5f * xf;
    int i = *(int*)&xf;
    i = 0x5f3759df - (i >> 1);
    xf = *(float*)&i;
    xf = xf * (1.5f - xhalf * xf * xf);
    return static_cast<double>(xf);
}

NATIV_EXPORT(sync)
std::string greet(const std::string& name) {
    return "Hi..." + name + " from C++!";
}
