// Apple Vision's object tracker (revision 1) for the watcher, over stdin and stdout.
//
// Each request is one JSON line, then the frame's grey pixels (width × height bytes):
//   {"width":320,"height":240,"things":[{"id":"mug","box":[x,y,w,h]}]}
// Each answer is one JSON line:
//   {"boxes":{"mug":[x,y,w,h,confidence]},"ms":0.4}
// Boxes are shares of the frame from its top-left corner, as the watcher's are. A thing
// is followed from the last box it was given back; one sent elsewhere (SAM re-anchored
// it, the template found it away from here) starts again from the box sent, on this frame.
// A thing Vision can't follow is left out of the answer.
import CoreVideo
import Foundation
import Vision

struct Thing: Decodable {
  let id: String
  let box: [Double]
}
struct Request: Decodable {
  let width: Int
  let height: Int
  let things: [Thing]
}

/// Reads lines and exact byte counts from stdin.
final class Input {
  private var buffer = Data()
  private let handle = FileHandle.standardInput
  private func fill() -> Bool {
    let chunk = handle.availableData
    if chunk.isEmpty { return false }
    buffer.append(chunk)
    return true
  }
  func line() -> Data? {
    while true {
      if let end = buffer.firstIndex(of: 0x0A) {
        let line = buffer[buffer.startIndex..<end]
        buffer = Data(buffer[(end + 1)...])
        return Data(line)
      }
      if !fill() { return nil }
    }
  }
  func bytes(_ count: Int) -> Data? {
    while buffer.count < count { if !fill() { return nil } }
    let out = buffer.prefix(count)
    buffer = Data(buffer.dropFirst(count))
    return Data(out)
  }
}

/// Top-left unit box to Vision's bottom-left one, and back: the same flip both ways.
func flip(_ b: CGRect) -> CGRect {
  CGRect(x: b.minX, y: 1 - b.minY - b.height, width: b.width, height: b.height)
}
func iou(_ a: CGRect, _ b: CGRect) -> Double {
  let i = a.intersection(b)
  if i.isNull || i.isEmpty { return 0 }
  let inter = Double(i.width * i.height)
  return inter / (Double(a.width * a.height + b.width * b.height) - inter)
}

/// Below this overlap with the last box given back, a sent box starts the thing again.
let restartIoU = 0.5
var handler = VNSequenceRequestHandler()
var followed: [String: (observation: VNDetectedObjectObservation, box: CGRect)] = [:]
let input = Input()
let out = FileHandle.standardOutput

func pixels(_ data: Data, _ width: Int, _ height: Int) -> CVPixelBuffer? {
  var buffer: CVPixelBuffer?
  CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_OneComponent8, nil, &buffer)
  guard let buffer else { return nil }
  CVPixelBufferLockBaseAddress(buffer, [])
  let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  data.withUnsafeBytes { raw in
    let p = raw.bindMemory(to: UInt8.self).baseAddress!
    for y in 0..<height { memcpy(base + y * stride, p + y * width, width) }
  }
  CVPixelBufferUnlockBaseAddress(buffer, [])
  return buffer
}

while let header = input.line() {
  guard let request = try? JSONDecoder().decode(Request.self, from: header),
    let frame = input.bytes(request.width * request.height)
  else { break }
  let started = Date()
  var boxes: [String: [Double]] = [:]
  let things = request.things.filter { $0.box.count == 4 }
  let tracks = things.map { thing -> VNTrackObjectRequest in
    let sent = CGRect(x: thing.box[0], y: thing.box[1], width: thing.box[2], height: thing.box[3])
    let from =
      followed[thing.id].flatMap { iou($0.box, sent) >= restartIoU ? $0.observation : nil }
      ?? VNDetectedObjectObservation(boundingBox: flip(sent))
    let track = VNTrackObjectRequest(detectedObjectObservation: from)
    track.revision = VNTrackObjectRequestRevision1
    track.trackingLevel = .accurate
    return track
  }
  // All in one call: one at a time costs about five times as much.
  if !tracks.isEmpty, let buffer = pixels(frame, request.width, request.height) {
    do {
      try handler.perform(tracks, on: buffer)
      for (thing, track) in zip(things, tracks) {
        guard let seen = track.results?.first as? VNDetectedObjectObservation else {
          followed[thing.id] = nil
          continue
        }
        let box = flip(seen.boundingBox)
        followed[thing.id] = (seen, box)
        boxes[thing.id] = [box.minX, box.minY, box.width, box.height, Double(seen.confidence)]
      }
    } catch {
      // Too many trackers, or one gone bad: every thing starts again from the box sent next.
      followed.removeAll()
      handler = VNSequenceRequestHandler()
    }
  }
  let ms = Date().timeIntervalSince(started) * 1000
  let answer = try! JSONSerialization.data(withJSONObject: ["boxes": boxes, "ms": ms])
  out.write(answer)
  out.write(Data([0x0A]))
}
