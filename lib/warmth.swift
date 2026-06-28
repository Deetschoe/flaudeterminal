#!/usr/bin/env swift
//
// warmth.swift — Flaude's reading tint ✦
//
// Warms the Mac display (cuts blue light) so reading is easier on the eyes.
// Pure CoreGraphics: it lowers the blue/green channel maximums via a gamma
// ramp. Zero dependencies, no sudo — `swift` ships with the Xcode CLT.
//
//   swift warmth.swift <0.0 ... 1.0>   apply tint (0 = neutral, 1 = max warm)
//   swift warmth.swift reset           restore normal color
//
// Note: the ramp is volatile — macOS wipes it on logout/restart, a display
// change, or whenever ColorSync re-applies a profile. Re-run to re-apply.
//
import CoreGraphics
import Foundation

func activeDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return Array(ids.prefix(Int(count)))
}

func reset() {
    CGDisplayRestoreColorSyncSettings()
}

func applyWarm(intensity: Float) {
    let t = max(0, min(1, intensity))
    // At full intensity, knock blue down to ~55% and green to ~82% of max.
    let blueFloor: Float  = 0.55
    let greenFloor: Float = 0.82
    let blueMax  = 1.0 - (1.0 - blueFloor)  * t
    let greenMax = 1.0 - (1.0 - greenFloor) * t

    for id in activeDisplays() {
        let err = CGSetDisplayTransferByFormula(
            id,
            0.0, 1.0,      1.0,   // red:   min, max, gamma (unchanged)
            0.0, greenMax, 1.0,   // green
            0.0, blueMax,  1.0    // blue
        )
        if err != .success {
            FileHandle.standardError.write(
                "warmth: failed on display \(id) (CGError \(err.rawValue))\n".data(using: .utf8)!)
        }
    }
}

let args = CommandLine.arguments
guard args.count == 2 else {
    print("usage: swift warmth.swift <0.0-1.0 | reset>")
    exit(2)
}

if args[1].lowercased() == "reset" {
    reset()
} else if let value = Float(args[1]) {
    applyWarm(intensity: value)
} else {
    print("usage: swift warmth.swift <0.0-1.0 | reset>")
    exit(2)
}
