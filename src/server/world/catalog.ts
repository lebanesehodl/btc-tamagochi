import type { DenSlot } from "../../shared/world.ts";

export const DEN_CATALOG = {
  wall: {
    "genesis-poster": "Genesis poster",
    "badger-poster": "Honey badger poster",
  },
  floor: {
    "orange-rug": "Orange rug",
    "forest-rug": "Forest rug",
  },
  corner: {
    "amber-lamp": "Amber lamp",
    "hardy-cactus": "Hardy cactus",
  },
} as const satisfies Record<DenSlot, Record<string, string>>;

export function validDecoration(slot: DenSlot, itemId: string): boolean {
  return Object.hasOwn(DEN_CATALOG[slot], itemId);
}
