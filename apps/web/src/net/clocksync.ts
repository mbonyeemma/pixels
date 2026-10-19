export interface ClockSample {
  rtt: number;
  /** serverTime - clientTime, in ms */
  offset: number;
}

/**
 * NTP-lite clock sync: for each ping/pong we estimate the server clock offset assuming symmetric latency
 * and keep the sample with the lowest RTT out of the last N (lowest RTT == least asymmetric error).
 */
export class ClockSync {
  private samples: ClockSample[] = [];
  constructor(private readonly keep = 6) {}

  reset(): void {
    this.samples = [];
  }

  /** sentAt/receivedAt are client Date.now() values; serverTime is the server's clock when it answered. */
  add(sentAt: number, serverTime: number, receivedAt: number): { rtt: number; offset: number; best: ClockSample } {
    const rtt = Math.max(0, receivedAt - sentAt);
    const offset = serverTime - (sentAt + rtt / 2);
    const sample = { rtt, offset };
    this.samples.push(sample);
    if (this.samples.length > this.keep) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    return { rtt, offset, best };
  }
}
