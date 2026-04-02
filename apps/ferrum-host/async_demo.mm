// async_demo.mm — Async function examples for React Native Native.
//
// Pattern 1: Compute-bound — just return a value, the bridge handles threading.
// Pattern 2: OS API — you receive resolve/reject and call them from a completion handler.

#include "RNAnywhere.h"
#import <Foundation/Foundation.h>
#include <string>
#include <thread>
#include <chrono>

// ── Pattern 1: Compute-bound async ────────────────────────────────────
// The bridge dispatches this to a background thread automatically.
// Just write a normal function — it won't block the JS thread.

RNA_EXPORT(async)
std::string slowGreet(const std::string& name) {
    // Simulate heavy work (1 second)
    std::this_thread::sleep_for(std::chrono::seconds(1));
    return "Hello " + name + " (after 1s delay)!";
}

RNA_EXPORT(async)
int heavyCompute(int n) {
    // Compute-bound: calculate fibonacci the slow way
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

// ── Pattern 2: OS API with completion handler ─────────────────────────
// For APIs that are already async (network, location, etc.),
// use RNA_EXPORT_ASYNC_RAW — you get resolve/reject callbacks directly.
// Call resolve(jsonString) or reject(code, message) when done.
//
// NOTE: This pattern is for APIs where YOU control when to resolve.
// The bridge does NOT dispatch to a background thread — you're already
// on whatever thread the OS callback fires on.

// Example: fetch a URL using NSURLSession (fully async, no thread blocking)
RNA_EXPORT(async)
std::string fetchURL(const std::string& url) {
    // This runs on a background thread (dispatched by the bridge).
    // We use a synchronous semaphore to wait for NSURLSession's async callback.
    // For a fully non-blocking version, you'd use the raw callback pattern.

    __block std::string result;
    __block NSError *fetchError = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    NSURL *nsurl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
    NSURLRequest *request = [NSURLRequest requestWithURL:nsurl];

    NSURLSessionDataTask *task = [[NSURLSession sharedSession]
        dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if (error) {
                fetchError = error;
            } else if (data) {
                NSString *body = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
                result = body ? [body UTF8String] : "(binary data)";
                // Truncate for display
                if (result.length() > 200) result = result.substr(0, 200) + "...";
            }
            dispatch_semaphore_signal(sem);
        }];
    [task resume];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    if (fetchError) {
        return std::string("Error: ") + [[fetchError localizedDescription] UTF8String];
    }
    return result;
}
