/*
 * AudioWorklet processor: forwards mono input frames to the main offscreen
 * thread. The AudioContext is created at 16 kHz (Whisper's required rate);
 * if the browser ignores the requested rate, offscreen.js resamples.
 */
class LSCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // input[0] is a reused 128-frame buffer; copy before posting.
      this.port.postMessage(input[0].slice(0));
    }
    return true; // keep the processor alive
  }
}

registerProcessor('ls-capture', LSCaptureProcessor);
