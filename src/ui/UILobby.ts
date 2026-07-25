import styles from '@/css/ui.module.css';
import { UIElementBase } from './UIElementBase';

/** A player as the lobby shows it — a subset of the relay's RosterPlayer. */
export interface UILobbyPlayer {
  id: string;
  name: string;
  ownerId: string;
}

export interface UILobbyJoinParams {
  name: string;
  room: string;
  server: string;
  secret: string;
}

export interface UILobbyOptions {
  /** prefill for the join form (query params / last session) */
  defaults?: Partial<UILobbyJoinParams>;
  /** shown read-only so everyone can confirm they're loading the same course */
  courseName?: string;
  /**
   * Player names supplied by a host app (OGS Desktop sends real players with
   * real club distances). When present the name field is replaced by a static
   * list — there's nothing to ask, and letting someone retype names here would
   * only risk detaching them from their clubs.
   */
  hostPlayers?: string[];
}

interface UILobbyEvents {
  /** the user filled in the form and hit Join */
  join: (params: UILobbyJoinParams) => void;
  /** the user hit Start — close the lobby and play */
  start: () => void;
  /** the user hit Leave, either from the lobby or the in-game pill */
  leave: () => void;
}

/**
 * The multiplayer front door: pick a name and a room code, watch players arrive,
 * start the round, and leave again. Once play begins the overlay collapses to a
 * small corner pill (room code + Leave) so there's always a way out.
 *
 * Deliberately transport-agnostic — it emits intent and renders whatever roster
 * it's handed. The caller owns the NetClient.
 */
export class UILobby extends UIElementBase<UILobbyEvents> {
  #card: HTMLElement;
  #form: HTMLElement;
  #room: HTMLElement;
  #status: HTMLElement;
  #players: HTMLElement;
  #pill: HTMLElement;
  #pillLabel: HTMLElement;
  #roomTitle: HTMLElement;
  #startButton: HTMLButtonElement;
  #joinButton: HTMLButtonElement;
  #hostPlayers: string[];
  #inputs: Record<keyof UILobbyJoinParams, HTMLInputElement>;

  constructor(parent: string | Element, options: UILobbyOptions = {}) {
    super(parent);
    const defaults = options.defaults ?? {};

    this.element.className = styles.lobby;

    this.#card = document.createElement('div');
    this.#card.className = styles.lobbyCard;

    const title = document.createElement('div');
    title.className = styles.lobbyTitle;
    title.textContent = 'Multiplayer';

    // ---- join form ----
    this.#form = document.createElement('div');
    this.#form.className = styles.lobbyCard;
    this.#form.style.padding = '0';
    this.#form.style.border = 'none';
    this.#form.style.background = 'none';

    const hostPlayers = options.hostPlayers ?? [];
    this.#hostPlayers = hostPlayers;
    this.#inputs = {
      // two names here seats two players on this machine — the garage case
      name: this.#field('Your name (comma separated for 2 local players)', defaults.name ?? '', 'Lake, Sarah'),
      room: this.#field('Room code', defaults.room ?? '', 'garage'),
      server: this.#field('Relay server', defaults.server ?? 'localhost:8080', 'host:port'),
      secret: this.#field('Room secret (optional)', defaults.secret ?? '', ''),
    };
    for (const key of ['name', 'room', 'server', 'secret'] as const) {
      // the host app already told us who's playing — show them, don't ask
      if (key === 'name' && hostPlayers.length) continue;
      this.#form.append(this.#inputs[key].parentElement!);
      this.#inputs[key].addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') this.#emitJoin();
      });
    }
    if (hostPlayers.length) {
      const wrapper = document.createElement('div');
      wrapper.className = styles.lobbyField;
      const label = document.createElement('div');
      label.className = styles.lobbyLabel;
      label.textContent = hostPlayers.length > 1 ? 'Playing on this machine' : 'Playing as';
      const list = document.createElement('div');
      list.className = styles.lobbyPlayers;
      list.append(...hostPlayers.map((name) => {
        const rowEl = document.createElement('div');
        rowEl.className = styles.lobbyPlayer;
        rowEl.textContent = name;
        return rowEl;
      }));
      wrapper.append(label, list);
      this.#form.prepend(wrapper);
    }

    this.#joinButton = this.#button('Join room', true);
    this.#joinButton.addEventListener('click', () => this.#emitJoin());
    this.#form.append(this.#joinButton);

    // ---- joined: roster + start/leave ----
    this.#room = document.createElement('div');
    this.#room.className = styles.lobbyCard;
    this.#room.style.padding = '0';
    this.#room.style.border = 'none';
    this.#room.style.background = 'none';
    this.#room.style.display = 'none';

    this.#roomTitle = document.createElement('div');
    this.#roomTitle.className = styles.lobbyLabel;

    this.#players = document.createElement('div');
    this.#players.className = styles.lobbyPlayers;

    this.#startButton = this.#button('Start round', true);
    this.#startButton.addEventListener('click', () => this.emit('start'));
    const leaveButton = this.#button('Leave');
    leaveButton.addEventListener('click', () => this.emit('leave'));

    const buttons = document.createElement('div');
    buttons.className = styles.lobbyRow;
    buttons.append(this.#startButton, leaveButton);
    this.#room.append(this.#roomTitle, this.#players, buttons);

    this.#status = document.createElement('div');
    this.#status.className = styles.lobbyStatus;

    this.#card.append(title);
    if (options.courseName) {
      const course = document.createElement('div');
      course.className = styles.lobbyStatus;
      course.textContent = `Course: ${options.courseName}`;
      this.#card.append(course);
    }
    this.#card.append(this.#form, this.#room, this.#status);
    this.element.append(this.#card);

    // ---- in-game pill ----
    this.#pill = document.createElement('div');
    this.#pill.className = styles.lobbyPill;
    this.#pillLabel = document.createElement('span');
    const pillLeave = document.createElement('span');
    pillLeave.className = styles.lobbyPillLeave;
    pillLeave.textContent = 'Leave';
    pillLeave.addEventListener('click', () => this.emit('leave'));
    this.#pill.append(this.#pillLabel, pillLeave);
    this.parent.append(this.#pill);
  }

  /** Show the overlay on the join form. */
  open() {
    this.#showOverlay(true);
    this.#form.style.display = 'flex';
    this.#room.style.display = 'none';
    this.#pill.classList.remove(styles.lobbyPillOpen);
    this.#setFormEnabled(true);
    (this.#hostPlayers.length ? this.#inputs.room : this.#inputs.name).focus();
  }

  /** Hide everything (single-machine play, or after a hard error). */
  close() {
    this.#showOverlay(false);
    this.#pill.classList.remove(styles.lobbyPillOpen);
  }

  /** Prefill the form without opening it (e.g. from ?room= query params). */
  setDefaults(defaults: Partial<UILobbyJoinParams>) {
    for (const key of ['name', 'room', 'server', 'secret'] as const) {
      const value = defaults[key];
      if (value !== undefined) this.#inputs[key].value = value;
    }
  }

  /** True while the full-screen lobby is covering the game. */
  get isOpen(): boolean {
    return this.element.classList.contains(styles.lobbyOpen);
  }

  /** Current form values — handy for auto-joining from query params. */
  get values(): UILobbyJoinParams {
    return {
      name: this.#hostPlayers.length
        ? this.#hostPlayers.join(', ')
        : this.#inputs.name.value.trim(),
      room: this.#inputs.room.value.trim(),
      server: this.#inputs.server.value.trim(),
      secret: this.#inputs.secret.value,
    };
  }

  /** One line of feedback under the card ("waiting for players…", errors). */
  setStatus(text: string, isError = false) {
    this.#status.textContent = text;
    this.#status.classList.toggle(styles.lobbyStatusError, isError);
  }

  /** Freeze the form while a connection attempt is in flight. */
  setConnecting(roomCode: string) {
    this.#setFormEnabled(false);
    this.setStatus(`Connecting to ${roomCode}…`);
  }

  /** An error the user can act on — hand the form back so they can retry. */
  setError(message: string) {
    this.#showOverlay(true);
    this.#form.style.display = 'flex';
    this.#room.style.display = 'none';
    this.#pill.classList.remove(styles.lobbyPillOpen);
    this.#setFormEnabled(true);
    this.setStatus(message, true);
  }

  /** We're in the room — render who's here and offer Start. */
  setRoster(roomCode: string, players: UILobbyPlayer[], myClientId?: string) {
    this.#showOverlay(true);
    this.#form.style.display = 'none';
    this.#room.style.display = 'flex';
    this.#roomTitle.textContent = `Room ${roomCode} — ${players.length} player${players.length === 1 ? '' : 's'}`;

    this.#players.replaceChildren(
      ...players.map((player) => {
        const row = document.createElement('div');
        row.className = styles.lobbyPlayer;
        const name = document.createElement('span');
        name.textContent = player.name;
        row.append(name);
        if (myClientId && player.ownerId === myClientId) {
          const tag = document.createElement('span');
          tag.className = styles.lobbyPlayerTag;
          tag.textContent = 'You';
          row.append(tag);
        }
        return row;
      })
    );

    const alone = players.length < 2;
    this.#startButton.disabled = alone;
    this.setStatus(alone ? 'Waiting for someone to join…' : 'Ready — anyone can start the round.');
  }

  /** The round is under way: drop the overlay, leave a way out in the corner. */
  setPlaying(roomCode: string, playerCount: number) {
    this.#showOverlay(false);
    this.#pillLabel.textContent = `Room ${roomCode} · ${playerCount} players`;
    this.#pill.classList.add(styles.lobbyPillOpen);
  }

  #emitJoin() {
    const values = this.values;
    if (!values.name) return this.setStatus('Enter a name first.', true);
    if (!values.room) return this.setStatus('Enter a room code first.', true);
    if (!values.server) return this.setStatus('Enter a relay server address.', true);
    this.emit('join', values);
  }

  #setFormEnabled(enabled: boolean) {
    this.#joinButton.disabled = !enabled;
    for (const input of Object.values(this.#inputs)) input.disabled = !enabled;
  }

  #showOverlay(visible: boolean) {
    this.element.classList.toggle(styles.lobbyOpen, visible);
  }

  #field(label: string, value: string, placeholder: string): HTMLInputElement {
    const wrapper = document.createElement('div');
    wrapper.className = styles.lobbyField;
    const labelEl = document.createElement('label');
    labelEl.className = styles.lobbyLabel;
    labelEl.textContent = label;
    const input = document.createElement('input');
    input.className = styles.lobbyInput;
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    wrapper.append(labelEl, input); // input's parent is the wrapper the caller appends
    return input;
  }

  #button(label: string, primary = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? `${styles.lobbyButton} ${styles.lobbyButtonPrimary}` : styles.lobbyButton;
    button.textContent = label;
    return button;
  }
}
