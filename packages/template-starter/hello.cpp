// hello.cpp — Your first native function!
// Edit this file and save — it hot-reloads on device.

#include "Nativ.h"
#include <string>

RNA_EXPORT(sync)
int add(int a, int b) {
    return a + b;
}

RNA_EXPORT(sync)
std::string greet(const std::string& name) {
    return "Hello " + name + " from C++!";
}
