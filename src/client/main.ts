import type { ActionRequest, DenSlot, WorldSnapshot } from "../shared/world.ts";
import type { StoryEpisodeView, TriggerFamily } from "../shared/story.ts";

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let world: WorldSnapshot | null = null;
let stream: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;
let streamUnavailable = false;
let actionBusy = false;
let previousMeal: string | null = null;
let announceTimer: ReturnType<typeof setTimeout> | null = null;
let storyExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let announcedStoryExpiry: string | null = null;

const STORY_COPY = {
  "price-down": {
    state: "FIAT SICK", title: "FIAT SNACK TRUCK", sub: "Seed-oil special.",
    arrival: "Delivery at the door. Badger took the bag.",
    mood: "Everything tastes beige. Badger regrets the seed oil.",
    status: "FIAT SICK. Seed-oil special. Free care is open.",
    action: "Free care — go outside", doctor: "Dr. Lumen says: read the label. Then go outside.",
    recover: "WELL. No more seed-oil specials. Badger is fine.",
    expire: "The oil wore off. Badger carries on.",
  },
  "price-up": {
    state: "FED WELL", title: "STEAK TRUCK", sub: "Light-water special.",
    arrival: "Steak on the plate. Deuterium-depleted water on ice.",
    mood: "Badger drank the fancy water. Badger feels very good.",
    status: "FED WELL. Nothing to fix.",
    action: "Dismiss celebration", doctor: "Dr. Lumen says: the water is lighter. He did not say why.",
    expire: "The bottle is empty. The plate is empty. Badger is content.",
  },
  "hash-mischief": {
    state: "GLARED", title: "A DELIVERY", sub: "",
    arrival: "Something came with this block. A screen, left on.",
    mood: "Badger squints at everything.",
    status: "GLARED. Free care is open.",
    action: "Free care — dim the lights", doctor: "Dr. Lumen says: go outside.",
    recover: "WELL. The room is a better color.",
    expire: "The screen went dark. Badger carries on.",
  },
} as const;

function currentEpisode(): StoryEpisodeView | null {
  const episode = world?.story.episode;
  return episode && Date.parse(episode.expiresAt) > Date.now() ? episode : null;
}

function utcTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

function episodeFact(episode: StoryEpisodeView): string {
  if (episode.cause.kind === "demo") return "DEMO SCENARIO · no live market or block trigger";
  if (episode.cause.kind === "hash") return `Block ${episode.cause.height} · ${shortHash(episode.cause.blockHash)}`;
  const numeric = Number(episode.cause.change);
  const rounded = `${numeric > 0 ? "+" : "−"}${Math.abs(numeric).toFixed(1)}%`;
  const qualifying = Math.abs(Math.abs(numeric) - 5) <= 0.05 && Math.abs(numeric) > 5;
  const qualifier = qualifying ? ` (rounded; ${numeric < 0 ? "below −5.0" : "above +5.0"})` : "";
  return `BTC/USD · ${rounded}${qualifier} over 24h · CoinGecko · as of ${utcTime(episode.cause.sourceUpdatedAt)}`;
}

function renderStory(next: WorldSnapshot): void {
  const episode = currentEpisode();
  byId("story-section").classList.toggle("hidden", episode === null);
  byId("demo-stories").classList.toggle("hidden", !next.story.demoEnabled);
  if (storyExpiryTimer) clearTimeout(storyExpiryTimer);
  if (!episode) { updateButtons(); return; }
  const copy = STORY_COPY[episode.family];
  byId("story-section").className = `story-section story-${episode.family}${episode.demo ? " is-demo" : ""}`;
  byId("story-state").textContent = episode.demo ? `DEMO · ${copy.state}` : copy.state;
  byId("story-fact").textContent = episodeFact(episode);
  byId("story-title").textContent = copy.title;
  byId("story-sub").textContent = copy.sub;
  byId("story-sub").classList.toggle("hidden", !copy.sub);
  byId("story-arrival").textContent = copy.arrival;
  byId("story-mood").textContent = copy.mood;
  byId("story-status").textContent = copy.status;
  byId("story-action").textContent = copy.action;
  byId("story-doctor").textContent = copy.doctor;
  byId("story-expiry").textContent = `Automatic close at ${utcTime(episode.expiresAt)}.`;
  storyExpiryTimer = setTimeout(() => {
    if (world?.story.episode?.id === episode.id) {
      announceStoryExpiry(episode);
      renderStory(world);
    }
    void refresh();
  }, Math.max(1000, Date.parse(episode.expiresAt) - Date.now() + 1000));
  updateButtons();
}

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

function announceStoryExpiry(episode: StoryEpisodeView): void {
  if (announcedStoryExpiry === episode.id) return;
  announcedStoryExpiry = episode.id;
  announce(STORY_COPY[episode.family].expire);
}

function renderConnectionStatus(syncStatus: WorldSnapshot["chain"]["syncStatus"]): void {
  if (streamUnavailable && stream?.readyState !== EventSource.OPEN) {
    renderStreamUnavailable();
    return;
  }
  byId("connection").className = `connection ${syncStatus}`;
  byId("connection-label").textContent = {
    starting: "Connecting to the den…",
    synced: "In step with the chain",
    "catching-up": "Catching up on meals",
    degraded: "The block source isn't answering. Satoshi keeps what he has.",
    paused: "Meals are paused. Play and decorating still work.",
  }[syncStatus];
}

function render(next: WorldSnapshot): void {
  if (world !== null && next.revision <= world.revision) return;
  const isNewMeal = next.pet.lastMeal && next.pet.lastMeal.blockHash !== previousMeal;
  const evolved = world?.pet.stage === "cub" && next.pet.stage === "rowdy";
  const previousEpisode = world?.story.episode ?? null;
  const nextEpisode = next.story.episode?.id;
  const newStory = nextEpisode !== undefined && nextEpisode !== previousEpisode?.id;
  const expiredStory = previousEpisode !== null && nextEpisode === undefined
    && Date.parse(previousEpisode.expiresAt) <= Date.now();
  world = next;
  previousMeal = next.pet.lastMeal?.blockHash ?? null;

  byId("block-height").textContent = next.chain.height === null ? "—" : `#${next.chain.height.toLocaleString()}`;
  byId("block-hash").textContent = next.chain.hash ? shortHash(next.chain.hash) : "Waiting for the chain…";
  byId("block-hash").title = next.chain.hash ?? "No block observed yet";
  byId("observed-at").textContent = next.chain.observedAt
    ? `Observed ${new Date(next.chain.observedAt).toLocaleString()}`
    : "Provider data not yet observed";

  renderConnectionStatus(next.chain.syncStatus);

  byId("pet-stage").textContent = next.pet.stage.toUpperCase();
  const badger = byId<HTMLImageElement>("badger");
  const sprite = next.pet.stage === "rowdy" ? "rowdy" : next.pet.mood === "joyful" ? "joyful" : "neutral";
  const spriteUrl = `/satoshi/satoshi-${sprite}-48.png`;
  if (badger.getAttribute("src") !== spriteUrl) badger.src = spriteUrl;
  badger.alt = `Satoshi, the communal honey badger${sprite === "rowdy" ? ", now rowdy" : sprite === "joyful" ? ", looking joyful" : ""}`;
  badger.className = `badger ${next.pet.stage} ${next.pet.mood}`;
  byId("den-scene").className = `den-scene mood-${next.pet.mood}${next.story.episode ? ` story-${next.story.episode.family}` : ""}`;
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
  renderStory(next);
  if (expiredStory && previousEpisode) announceStoryExpiry(previousEpisode);
  if (newStory && next.story.episode) announce(`${STORY_COPY[next.story.episode.family].title}. ${next.story.episode.demo ? "Simulated for this demo." : "A new den story is open."}`);
}

function renderStreamUnavailable(): void {
  byId("connection").className = "connection degraded";
  byId("connection-label").textContent = "Live link unavailable. Refreshing the den.";
}

function scheduleWorldRefresh(delayMs = 3000): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, delayMs);
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const response = await fetch("/api/world", { cache: "no-store" });
    if (!response.ok) throw new Error(`World request failed: ${response.status}`);
    const snapshot = await response.json() as WorldSnapshot;
    const shouldOpen = stream === null || stream.readyState === EventSource.CLOSED;
    render(snapshot);
    if (shouldOpen) openStream(snapshot.revision);
    if (streamUnavailable && stream?.readyState !== EventSource.OPEN) renderStreamUnavailable();
  } catch {
    if (stream?.readyState !== EventSource.OPEN) {
      byId("connection").className = "connection degraded";
      byId("connection-label").textContent = "Cannot reach the den—retrying";
      byId("announcement").textContent = "The den could not be reached. Trying again.";
      scheduleWorldRefresh(5000);
    }
  } finally {
    refreshInFlight = false;
    if (streamUnavailable && stream?.readyState !== EventSource.OPEN) scheduleWorldRefresh();
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
    streamUnavailable = true;
    renderStreamUnavailable();
    scheduleWorldRefresh();
  };
  stream.onopen = () => {
    streamUnavailable = false;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (world) renderConnectionStatus(world.chain.syncStatus);
  };
}

function friendlyActionError(status: number, code: unknown): string {
  if (status === 409 && code === "slot_taken") return "Someone else placed this one. Pick a spot that's still open.";
  if (status === 409 && code === "den_changed") return "Someone changed that spot first. Here is the den now.";
  if (status === 409 && code === "story_closed") return "That story has already closed. Here is the den now.";
  if (status === 409 && code === "story_no_care") return "The celebration needs no care; dismiss it instead.";
  if (status === 429) return "A little pause. Try again soon.";
  return "That didn't go through. Try again.";
}

async function act(action: ActionRequest): Promise<void> {
  if (actionBusy) return;
  const storyFamily = action.kind === "story-care" ? world?.story.episode?.family : null;
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
    else if (action.kind === "story-care" && storyFamily === "price-down") announce(STORY_COPY["price-down"].recover);
    else if (action.kind === "story-care" && storyFamily === "hash-mischief") announce(STORY_COPY["hash-mischief"].recover);
    else if (action.kind === "story-dismiss") announce("The bottle is empty. The plate is empty. Badger is content.");
    else if (action.kind === "story-demo") announce("Demo story opened. No live quote or block caused it.");
    else if (action.kind === "decorate") {
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
  const episode = currentEpisode();
  byId<HTMLButtonElement>("story-action").disabled = actionBusy || episode === null;
  document.querySelectorAll<HTMLButtonElement>("[data-demo-family]").forEach((button) => { button.disabled = actionBusy; });
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
byId("story-action").addEventListener("click", () => {
  const episode = currentEpisode();
  if (!episode) return;
  void act({ kind: episode.family === "price-up" ? "story-dismiss" : "story-care", episodeId: episode.id });
});
document.querySelectorAll<HTMLButtonElement>("[data-demo-family]").forEach((button) => {
  button.addEventListener("click", () => void act({ kind: "story-demo", family: button.dataset.demoFamily as TriggerFamily }));
});
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
