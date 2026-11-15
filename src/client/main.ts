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
    synced: "Live on Bitcoin time",
    "catching-up": "Catching up on meals",
    degraded: "Connection trouble—pet is safe",
    paused: "Chain reconciliation paused—pet is safe",
  }[next.chain.syncStatus];

  byId("pet-stage").textContent = next.pet.stage.toUpperCase();
  byId("badger").className = `badger ${next.pet.stage} ${next.pet.mood}`;
  byId("den-scene").className = `den-scene mood-${next.pet.mood}`;
  byId("mood-label").textContent = next.pet.mood.toUpperCase();
  byId("meal-count").textContent = String(next.pet.meals);
  byId("fullness-label").textContent = `${next.pet.fullness}%`;
  byId("joy-label").textContent = `JOY ${next.pet.joy}/100`;
  byId<HTMLProgressElement>("growth-fill").value = Math.min(12, next.pet.growthBlocks);
  byId("growth-label").textContent = next.pet.nextEvolutionAt === null
    ? `Evolved after ${next.pet.growthBlocks} blocks together.`
    : `${next.pet.growthBlocks}/12 growth blocks · evolution at height ${next.pet.nextEvolutionAt}`;

  const meal = next.pet.lastMeal;
  byId("food-name").textContent = meal?.foodName ?? "Nothing yet";
  byId("food-reaction").textContent = meal
    ? `${meal.reaction === "happy" ? "A very good bite." : meal.reaction === "curious" ? "Sniff first. Then devour." : "Full belly. Tiny nap."} Delivered by block #${meal.height}.`
    : "Every observed block delivers the same pantry item to everyone.";
  byId("meal-bubble").textContent = meal ? `${meal.foodName} · block #${meal.height}` : "A new block will bring dinner.";
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
  } catch (error) {
    byId("connection").className = "connection degraded";
    byId("connection-label").textContent = "Cannot reach the den—retrying";
    byId("announcement").textContent = error instanceof Error ? error.message : "Connection failed";
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
    byId("connection-label").textContent = "Live updates reconnecting—pet is safe";
  };
  stream.onopen = () => {
    if (world) {
      byId("connection").className = `connection ${world.chain.syncStatus}`;
      byId("connection-label").textContent = "Live on Bitcoin time";
    }
  };
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
    if (!response.ok) throw new Error(result.error ?? `Action failed: ${response.status}`);
    render(result.snapshot as WorldSnapshot);
    if (action.kind === "play") announce("Badger joy increased. That was definitely your doing.");
    else announce("Your decoration has a home in the communal den.");
  } catch (error) {
    byId("action-error").textContent = error instanceof Error ? error.message : "Action failed";
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
  });
  document.querySelectorAll<HTMLButtonElement>(".slot-control").forEach((control) => {
    const label = control.querySelector("span") as HTMLSpanElement;
    const slot = control.dataset.slot as DenSlot;
    const item = world?.den.find((entry) => entry.slot === slot)?.itemId;
    label.textContent = `${slot[0]?.toUpperCase()}${slot.slice(1)}${item ? ` · ${item.replaceAll("-", " ")}` : ""}`;
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
