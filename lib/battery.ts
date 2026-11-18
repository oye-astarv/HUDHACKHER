"use client";

/** Battery fraction at which SafeStride pings a safe haven on its own. */
export const LOW_BATTERY_LEVEL = 0.1;

type BatteryManagerLike = {
  level: number;
  charging: boolean;
  addEventListener: (type: "levelchange" | "chargingchange", listener: () => void) => void;
  removeEventListener: (type: "levelchange" | "chargingchange", listener: () => void) => void;
};

type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<BatteryManagerLike>;
};

/**
 * Fires once when the device drops to 10% while unplugged. The Battery Status
 * API is Chromium-only (no Safari/iOS), so callers should also listen for the
 * manual `safestride:low-battery` event to run the same flow on stage.
 */
export function watchLowBattery(onLow: (level: number) => void): () => void {
  const getBattery = (navigator as NavigatorWithBattery).getBattery;
  if (typeof getBattery !== "function") return () => {};

  let battery: BatteryManagerLike | null = null;
  let cancelled = false;
  let fired = false;

  const check = () => {
    if (!battery || fired || battery.charging) return;
    if (battery.level > LOW_BATTERY_LEVEL) return;
    fired = true;
    onLow(battery.level);
  };

  getBattery
    .call(navigator)
    .then((manager) => {
      if (cancelled) return;
      battery = manager;
      manager.addEventListener("levelchange", check);
      manager.addEventListener("chargingchange", check);
      check();
    })
    .catch(() => undefined);

  return () => {
    cancelled = true;
    battery?.removeEventListener("levelchange", check);
    battery?.removeEventListener("chargingchange", check);
  };
}
