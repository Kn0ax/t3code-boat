import { describe, expect, it } from "vite-plus/test";

import { waitForBoatSnapshot } from "./boatSnapshots";

const poll = (statuses: ReadonlyArray<string | null>, signal?: AbortSignal) => {
  let clock = 0;
  let reads = 0;
  const outcome = waitForBoatSnapshot({
    readStatus: async () => statuses[reads++] ?? "saving",
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    intervalMs: 10,
    timeoutMs: 100,
    ...(signal === undefined ? {} : { signal }),
  });
  return outcome.then((result) => ({ result, reads: () => reads }));
};

describe("waitForBoatSnapshot", () => {
  it("keeps polling through unreadable answers until boat settles", async () => {
    const { result, reads } = await poll(["saving", null, "ready"]);
    expect(result).toBe("ready");
    expect(reads()).toBe(3);
  });

  it("stops at a failed save", async () => {
    expect((await poll(["failed"])).result).toBe("failed");
  });

  it("gives up at the deadline", async () => {
    const { result, reads } = await poll([]);
    expect(result).toBe("timed-out");
    expect(reads()).toBe(10);
  });

  it("stops without reading once cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, reads } = await poll(["ready"], controller.signal);
    expect(result).toBe("cancelled");
    expect(reads()).toBe(0);
  });
});
