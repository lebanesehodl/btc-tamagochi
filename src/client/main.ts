import type { ActionRequest, DenSlot, WorldSnapshot } from "../shared/world.ts";

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let world: WorldSnapshot | null = null;
let stream: EventSource | null = null;
let actionBusy = false;
let previousMeal: string | null = null;
let announceTimer: ReturnType<typeof setTimeout> | null = null;

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function announce(message: string): void {
  const element = byId("announcement");
  element.textContent = message;
  element.classList.add("highlight");
  if (announceTimer) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => element.classList.remove("highlight"), 1800);
}

function render(next: WorldSnapshot): void {
  const isNewMeal = next.pet.lastMeal && next.pet.lastMeal.blockHash !== previousMeal;
  const evolved = world?.pet.stage === "cub" && next.pet.stage === "rowdy";
  const wasBehind = world !== null && next.revision <= world.revision;
  world = next;
  if (wasBehind) return;
  previousMeal = next.pet.lastMeal?.blockHash ?? null;

  byId("block-height").textContent = next.chain.height === null ? "—" : `#${next.chain.height.toLocaleString()}`;
  byId("block-hash").textContent = next.chain.hash ? shortHash(next.chain.hash) : "Waiting for the chain…";
  byId("block-hash").title = next.chain.hash ?? "No block observed yet";
  byId("observed-at").textContent = next.chain.observedAt
    ? `Observed ${new Date(next.chain.observedAt).toLocaleString()}`
    : "Provider data not yet observed";

  const connection = byId("connection");
  connection.className = `connection ${next.chain.syncStatus}`;
  byId("connection-label").textContent = {
    starting: "Connecting to the den…",
    synced: "In step with the chain",
    "catching-up": "Catching up on meals",
    degraded: "The block source isn't answering. Satoshi keeps what he has.",
    paused: "Meals are paused. Play and decorating still work.",
  }[next.chain.syncStatus];

  byId("pet-stage").textContent = next.pet.stage.toUpperCase();
  const badger = byId<HTMLImageElement>("badger");
  const sprite = next.pet.stage === "rowdy" ? "rowdy" : next.pet.mood === "joyful" ? "joyful" : "neutral";
  const spriteUrl = `/satoshi/satoshi-${sprite}-48.png`;
  if (badger.getAttribute("src") !== spriteUrl) badger.src = spriteUrl;
  badger.alt = `Satoshi, the communal honey badger${sprite === "rowdy" ? ", now rowdy" : sprite === "joyful" ? ", looking joyful" : ""}`;
  badger.className = `badger ${next.pet.stage} ${next.pet.mood}`;
  byId("den-scene").className = `den-scene mood-${next.pet.mood}`;
  byId("mood-label").textContent = next.pet.mood.toUpperCase();
  byId("meal-count").textContent = String(next.pet.meals);
  byId("fullness-label").textContent = `${next.pet.fullness}%`;
  byId("joy-label").textContent = `JOY ${next.pet.joy}/100`;
  byId<HTMLProgressElement>("growth-fill").value = Math.min(12, next.pet.growthBlocks);
  byId("growth-label").textContent = next.pet.nextEvolutionAt === null
    ? `Evolved after ${next.pet.growthBlocks} blocks together.`
    : `${next.pet.growthBlocks} of 12 blocks to growing up. Next stage at block ${next.pet.nextEvolutionAt}.`;

  const meal = next.pet.lastMeal;
  const reaction = meal?.reaction === "happy" ? "A very good bite." : meal?.reaction === "curious" ? "Sniff first. Then devour." : "Full belly. Tiny nap.";
  byId("food-name").textContent = meal?.foodName ?? "Nothing yet";
  byId("food-reaction").textContent = meal
    ? `${reaction} Delivered by block #${meal.height}.`
    : "Every observed block delivers the same pantry item to everyone.";
  byId("meal-bubble").textContent = meal ? reaction : "A new block will bring dinner.";
  byId("food").classList.toggle("hidden", !meal);
  byId("food-icon").className = meal ? `food-icon ${meal.foodId}` : "food-icon";

  for (const decoration of next.den) {
    const element = byId(`den-${decoration.slot}`);
    element.className = `den-decoration decoration-${decoration.slot} ${decoration.itemId ?? "empty"}`;
    element.setAttribute("aria-label", `${decoration.slot}: ${decoration.itemId ?? "empty"}`);
    const controls = document.querySelector(`.slot-control[data-slot="${decoration.slot}"]`);
    controls?.classList.toggle("slot-occupied", decoration.itemId !== null);
  }

  if (isNewMeal && meal) {
    byId("badger").classList.add("eating");
    announce(evolved ? "Satoshi is a rowdy badger now. Twelve blocks did it." : `Block #${meal.height} delivered ${meal.foodName}. The badger approves.`);
    setTimeout(() => byId("badger").classList.remove("eating"), 1600);
  }
  updateButtons();
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/world", { cache: "no-store" });
    if (!response.ok) throw new Error(`World request failed: ${response.status}`);
    const snapshot = await response.json() as WorldSnapshot;
    const shouldOpen = stream === null || stream.readyState === EventSource.CLOSED;
    render(snapshot);
    if (shouldOpen) openStream(snapshot.revision);
  } catch {
    byId("connection").className = "connection degraded";
    byId("connection-label").textContent = "Cannot reach the den—retrying";
    byId("announcement").textContent = "The den could not be reached. Trying again.";
    setTimeout(refresh, 5000);
  }
}

function openStream(after: number): void {
  stream?.close();
  stream = new EventSource(`/api/stream?after=${after}`);
  stream.addEventListener("world", (event) => {
    const change = JSON.parse((event as MessageEvent).data) as WorldSnapshot;
    render(change);
  });
  stream.addEventListener("reset", (event) => {
    const snapshot = JSON.parse((event as MessageEvent).data) as WorldSnapshot;
    render(snapshot);
  });
  stream.onerror = () => {
    byId("connection").className = "connection degraded";
    byId("connection-label").textContent = "Lost the live link. Reconnecting.";
  };
  stream.onopen = () => {
    if (world) {
      byId("connection").className = `connection ${world.chain.syncStatus}`;
      byId("connection-label").textContent = "In step with the chain";
    }
  };
}

function friendlyActionError(status: number, code: unknown): string {
  if (status === 409 && code === "slot_taken") return "Someone else placed this one. Pick a spot that's still open.";
  if (status === 409 && code === "den_changed") return "Someone changed that spot first. Here is the den now.";
  if (status === 429) return "A little pause. Try again soon.";
  return "That didn't go through. Try again.";
}

async function act(action: ActionRequest): Promise<void> {
  if (actionBusy) return;
  actionBusy = true;
  byId("action-error").textContent = "";
  document.querySelectorAll("button").forEach((button) => { (button as HTMLButtonElement).disabled = true; });
  try {
    const response = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(action),
    });
    const result = await response.json();
    if (!response.ok) {
      byId("action-error").textContent = friendlyActionError(response.status, result?.code);
      await refresh();
      return;
    }
    render(result.snapshot as WorldSnapshot);
    if (action.kind === "play") announce("Badger joy increased. That was definitely your doing.");
    else {
      const itemName = document.querySelector(`[data-slot="${action.slot}"] [data-item="${action.itemId}"]`)?.textContent ?? action.itemId.replaceAll("-", " ");
      announce(`The ${action.slot} now has ${itemName}.`);
    }
  } catch {
    byId("action-error").textContent = "The den could not hear that. Try again.";
    await refresh();
  } finally {
    actionBusy = false;
    document.querySelectorAll("button").forEach((button) => { (button as HTMLButtonElement).disabled = false; });
    updateButtons();
  }
}

function updateButtons(): void {
  if (!world) return;
  document.querySelectorAll<HTMLButtonElement>(".slot-control button").forEach((button) => {
    const parent = button.closest(".slot-control") as HTMLElement;
    const slot = parent.dataset.slot as DenSlot;
    const decoration = world?.den.find((item) => item.slot === slot);
    button.disabled = actionBusy || decoration?.itemId !== null;
    if (decoration?.itemId) button.setAttribute("aria-describedby", `slot-state-${slot}`);
    else button.removeAttribute("aria-describedby");
  });
  document.querySelectorAll<HTMLElement>(".slot-control").forEach((control) => {
    const label = control.querySelector("span") as HTMLSpanElement;
    const slot = control.dataset.slot as DenSlot;
    const item = world?.den.find((entry) => entry.slot === slot)?.itemId;
    label.textContent = `${slot[0]?.toUpperCase()}${slot.slice(1)}${item ? ` · ${item.replaceAll("-", " ")}` : ""}`;
    const note = control.querySelector<HTMLElement>(".slot-state");
    if (note) note.textContent = item ? "This spot is taken. Pick another." : "";
  });
}

byId("play-button").addEventListener("click", () => act({ kind: "play" }));
document.querySelectorAll<HTMLButtonElement>(".slot-control button").forEach((button) => {
  button.addEventListener("click", () => {
    const parent = button.closest(".slot-control") as HTMLElement;
    const slot = parent.dataset.slot as DenSlot;
    const version = world?.den.find((item) => item.slot === slot)?.version ?? 0;
    void act({ kind: "decorate", slot, itemId: button.dataset.item ?? "", expectedVersion: version });
  });
});

void refresh();
window.addEventListener("beforeunload", () => stream?.close());
