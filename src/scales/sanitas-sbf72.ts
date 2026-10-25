import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { buildPayload, uuid16 } from './body-comp-helpers.js';
import { SigMeasurementPairing } from './sig-bcs.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, normalizeUuid } from '../ble/types.js';

// Standard SIG characteristics (inherited from openScale's
// StandardWeightProfileHandler, which subscribes both measurements).
const CHR_WEIGHT_MEAS = uuid16(0x2a9d); // Weight Scale Service 0x181D
const CHR_BODY_COMP_MEAS = uuid16(0x2a9c); // Body Composition Service 0x181B
const CHR_USER_CONTROL_POINT = uuid16(0x2a9f); // User Data Service 0x181C
const CHR_CURRENT_TIME = uuid16(0x2a2b); // Current Time Service 0x1805

// Vendor characteristics on the custom service 0xFFFF (openScale
// SanitasSbf72Handler). Their UUIDs are the SIG base with 0x0001 .. 0x0006.
const CHR_VENDOR_USER_LIST = uuid16(0x0001); // write 00: one frame per user slot
const CHR_VENDOR_TAKE_MEASUREMENT = uuid16(0x0006); // write 00 after consent

/** How long a 0x2A9D weight waits for the 0x2A9C that follows it. */
const BCS_WAIT_MS = 5000;
/** Consent is re-sent at this interval until the scale answers it. */
const CONSENT_RETRY_MS = 5000;
/**
 * How long onConnected waits for the vendor user list before consenting, when
 * config names no slot. The list only decides which slot to consent to, so a
 * scale that never answers costs this delay and nothing else.
 */
const USER_LIST_WAIT_MS = 3000;

// User Control Point opcodes and results (SIG User Data Service).
const UCP_CONSENT = 0x02;
const UCP_RESPONSE = 0x20;
const UCP_RESULT_SUCCESS = 0x01;
const UCP_RESULT_NOT_AUTHORIZED = 0x05;

const UCP_RESULTS: Record<number, string> = {
  0x01: 'SUCCESS',
  0x02: 'OP_CODE_NOT_SUPPORTED',
  0x03: 'INVALID_PARAMETER',
  0x04: 'OPERATION_FAILED',
  0x05: 'USER_NOT_AUTHORIZED',
};

// Vendor user-list status byte (first byte of each 0x0001 frame).
const LIST_END = 0x01;
const LIST_NO_USER = 0x02;
/**
 * Writing `0x10 + slot` to 0x0001 makes the scale show that slot's consent
 * code on its display; the scale echoes the request (openScale filters 0x11,
 * the echo for slot 1). Any status from 0x10 up is such an echo.
 */
const PIN_DISPLAY_BASE = 0x10;

/** Render bytes as spaced lowercase hex for the diagnostic log lines. */
const hex = (b: Buffer | number[]): string =>
  Array.from(b)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join(' ');

/** One stored user slot, as the vendor user list reports it. */
interface ScaleSlot {
  index: number;
  initials: string;
  year: number;
  month: number;
  day: number;
  heightCm: number;
  gender: 'male' | 'female';
  activityLevel: number;
}

/**
 * Decode one vendor user-list record (openScale handleSBF72UserList):
 * `00 <index> <initials x3> <year u16 LE> <month> <day> <height cm> <gender>
 * <activity 1-5>`, gender 0 male. Initials `ff ff ff` are unset.
 */
function parseSlot(data: Buffer): ScaleSlot | null {
  if (data.length < 12) return null;
  const raw = data.subarray(2, 5);
  const initials = raw.every((b) => b === 0xff)
    ? 'unknown'
    : raw
        .toString('latin1')
        .replace(/\0.*$/, '')
        .trim();
  return {
    index: data[1],
    initials,
    year: data.readUInt16LE(5),
    month: data[7],
    day: data[8],
    heightCm: data[9],
    gender: data[10] === 0 ? 'male' : 'female',
    activityLevel: data[11],
  };
}

/**
 * The slot that is plainly this profile: same gender, birth year and height
 * within 2 cm, and the only one that is. Anything ambiguous returns undefined,
 * because consenting to somebody else's slot attributes their weigh-ins here.
 */
function slotForProfile(slots: ScaleSlot[], p: UserProfile): number | undefined {
  const born = p.birthDate ? new Date(p.birthDate) : null;
  const year =
    born && !Number.isNaN(born.getTime())
      ? born.getUTCFullYear()
      : new Date().getFullYear() - Math.round(p.age);
  // Without a birth date the year is derived from the age and can be one off.
  const yearSlack = p.birthDate ? 0 : 1;
  const hits = slots.filter(
    (s) =>
      s.gender === p.gender &&
      Math.abs(s.year - year) <= yearSlack &&
      Math.abs(s.heightCm - p.height) <= 2,
  );
  return hits.length === 1 ? hits[0].index : undefined;
}

/** One connection's state, replaced whole in onSessionStart (#394). */
class Sbf72Session {
  ended = false;
  slots: ScaleSlot[] = [];
  /** Resolves the onConnected wait for the user list; set while it waits. */
  listDone: (() => void) | undefined;
  consentTimer: ReturnType<typeof setInterval> | undefined;
  consentSent = false;
  consentAnswered = false;
  pinDisplayRequested = false;
  readingEmitted = false;
}

/**
 * Adapter for Sanitas SBF72 / SBF73 scales.
 *
 * Protocol ported from openScale's SanitasSbf72Handler, which extends
 * StandardWeightProfileHandler: standard Weight Measurement (0x2A9D) and Body
 * Composition Measurement (0x2A9C), the User Data Service consent on the User
 * Control Point (0x2A9F), plus a custom service (0xFFFF) for the user list and
 * the measurement trigger. Both measurements are subscribed and paired into
 * one weigh-in (SigMeasurementPairing): the weight is mandatory only in
 * 0x2A9D, and both carry the SIG Time Stamp of a stored record (review C-02,
 * C-05).
 *
 * Connection sequence, as openScale runs it:
 *  1. Current Time (0x2A2B), best effort.
 *  2. Vendor user list: write `00` to 0x0001, the scale answers one frame per
 *     stored slot and an end frame. Logged, and used to pick the slot when
 *     config names none.
 *  3. Consent `02 <slot> <code u16 LE>` on 0x2A9F, with `users[].beurer_pin`
 *     and `users[].beurer_user_index` (default code 0 on slot 1, which is what
 *     this adapter always sent before). Re-sent every 5 s until answered.
 *  4. On SUCCESS, write `00` to 0x0006 to make the scale take the measurement.
 *     On USER_NOT_AUTHORIZED, write `0x10 + slot` to 0x0001 so the scale shows
 *     the slot's consent code, which the user then puts in `beurer_pin`.
 *
 * The Beurer BF915 is claimed by openScale's handler too. It needs a bonded
 * link and delivers its weight on 0x2A9D (#335, #417), so it belongs to
 * BeurerBf720Adapter (review C-07).
 */
export class SanitasSbf72Adapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition
{
  readonly name = 'Sanitas SBF72/73';
  readonly match: MatchDescriptor = {
    priority: 170,
    names: { includes: ['sbf72', 'sbf73'] },
  };
  readonly charNotifyUuid = CHR_BODY_COMP_MEAS;
  readonly charWriteUuid = CHR_USER_CONTROL_POINT;
  // 0x2A9C stays required, as it was when this adapter read 0x2A9C alone, and
  // onConnected requires 0x2A9F. The 0x2A9F indication is optional so that a
  // link that refuses it unbonded still reads as it did before: the consent is
  // then re-sent blind, unanswered.
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WEIGHT_MEAS, type: 'notify', optional: true },
    { uuid: CHR_BODY_COMP_MEAS, type: 'notify' },
    { uuid: CHR_USER_CONTROL_POINT, type: 'notify', optional: true },
    { uuid: CHR_VENDOR_USER_LIST, type: 'notify', optional: true },
    { uuid: CHR_VENDOR_TAKE_MEASUREMENT, type: 'write', optional: true },
    { uuid: CHR_CURRENT_TIME, type: 'write', optional: true },
  ];
  readonly completionHoldMs = BCS_WAIT_MS;

  /**
   * Pairs 0x2A9D with 0x2A9C and pins the scale's composition to the reading it
   * was measured with (#394): this adapter is a shared singleton and
   * `computeMetrics()` runs later than the parse.
   */
  private readonly sig = new SigMeasurementPairing();
  private s = new Sbf72Session();
  /** Live only between onConnected and onSessionEnd (#138). */
  private ctx: ConnectionContext | undefined;
  private userIndex = 1;
  private pin = 0;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * The pin is what fixes the real leak. This reset covers the OTHER path: a
   * reading built outside the parsers (a direct caller, a test) has nothing
   * pinned, so computeMetrics falls back to the latest composition, which must
   * not still hold the previous person's numbers.
   */
  onSessionStart(): void {
    this.stopConsentRetry();
    this.s = new Sbf72Session();
    this.sig.reset();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    if (!ctx.availableChars.has(CHR_USER_CONTROL_POINT)) {
      throw new Error(
        `Sanitas SBF72: User Control Point ${CHR_USER_CONTROL_POINT} not discovered. ` +
          'Likely a transient GATT discovery race. Try again.',
      );
    }
    const s = this.s;
    this.ctx = ctx;
    this.pin = ctx.scaleAuth?.pin ?? 0;
    const configuredIndex = ctx.scaleAuth?.userIndex;

    if (ctx.availableChars.has(CHR_CURRENT_TIME)) {
      try {
        await ctx.write(CHR_CURRENT_TIME, buildCurrentTime(), true);
      } catch (err) {
        bleLog.debug(`Sanitas SBF72: current time write failed: ${String(err)}`);
      }
    }

    if (ctx.availableChars.has(CHR_VENDOR_USER_LIST)) {
      // Only wait for the answer when it decides the slot.
      const listed =
        configuredIndex == null
          ? new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, USER_LIST_WAIT_MS);
              s.listDone = () => {
                clearTimeout(timer);
                resolve();
              };
            })
          : undefined;
      try {
        await ctx.write(CHR_VENDOR_USER_LIST, [0x00], true);
        await listed;
      } catch (err) {
        bleLog.debug(`Sanitas SBF72: vendor user-list query failed: ${String(err)}`);
      }
      s.listDone = undefined;
      if (s.ended) return;
    }

    const matched = configuredIndex == null ? slotForProfile(s.slots, ctx.profile) : undefined;
    this.userIndex = configuredIndex ?? matched ?? 1;
    if (matched != null) {
      bleLog.info(
        `Sanitas SBF72: user slot ${matched} matches this profile; consenting to it. ` +
          `Set 'users[].beurer_user_index: ${matched}' to pin it.`,
      );
    }

    await this.sendConsent(s);
    // The scale stays silent until it has a consent it accepts, and the first
    // write can land before the indication is enabled on some transports.
    s.consentTimer = setInterval(() => void this.sendConsent(s), CONSENT_RETRY_MS);
  }

  private async sendConsent(s: Sbf72Session): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || s !== this.s || s.ended || s.consentAnswered) {
      this.stopConsentRetry(s);
      return;
    }
    const pin = this.pin;
    try {
      await ctx.write(
        CHR_USER_CONTROL_POINT,
        [UCP_CONSENT, this.userIndex & 0xff, pin & 0xff, (pin >> 8) & 0xff],
        true,
      );
      if (!s.consentSent) {
        bleLog.debug(`Sanitas SBF72: consent sent for user index ${this.userIndex}`);
      }
      s.consentSent = true;
    } catch (err) {
      bleLog.debug(`Sanitas SBF72: consent write failed: ${String(err)}`);
    }
  }

  private stopConsentRetry(s: Sbf72Session = this.s): void {
    if (s.consentTimer) clearInterval(s.consentTimer);
    s.consentTimer = undefined;
  }

  /** Write a vendor command, isolated: none of them may cost the reading. */
  private writeVendor(s: Sbf72Session, uuid: string, data: number[], what: string): void {
    const ctx = this.ctx;
    if (!ctx || s !== this.s || s.ended || !ctx.availableChars.has(uuid)) return;
    ctx.write(uuid, data, true).catch((err: unknown) => {
      bleLog.debug(`Sanitas SBF72: ${what} write failed: ${String(err)}`);
    });
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    const uuid = normalizeUuid(charUuid);
    if (uuid === CHR_USER_CONTROL_POINT) {
      this.handleUcpResponse(data);
      return null;
    }
    if (uuid === CHR_VENDOR_USER_LIST) {
      this.handleUserListFrame(data);
      return null;
    }
    let reading: ScaleReading | null = null;
    if (uuid === CHR_WEIGHT_MEAS) reading = this.sig.onWeight(data);
    if (uuid === CHR_BODY_COMP_MEAS) reading = this.sig.onBodyComposition(data);
    if (reading) this.s.readingEmitted = true;
    return reading;
  }

  /** User list and consent frames only answer our own writes. */
  isStatusFrame(charUuid: string): boolean {
    const uuid = normalizeUuid(charUuid);
    return uuid === CHR_USER_CONTROL_POINT || uuid === CHR_VENDOR_USER_LIST;
  }

  private handleUcpResponse(data: Buffer): void {
    if (data.length < 3 || data[0] !== UCP_RESPONSE) return;
    if (data[1] !== UCP_CONSENT) {
      bleLog.debug(
        `Sanitas SBF72: User Control Point response to opcode ` +
          `0x${data[1].toString(16).padStart(2, '0')}, ignored`,
      );
      return;
    }
    const s = this.s;
    s.consentAnswered = true;
    this.stopConsentRetry(s);
    const result = data[2];
    if (result === UCP_RESULT_SUCCESS) {
      bleLog.debug('Sanitas SBF72: consent accepted, requesting the measurement');
      // openScale onRequestMeasurement(): the scale measures on this command.
      this.writeVendor(s, CHR_VENDOR_TAKE_MEASUREMENT, [0x00], 'take-measurement');
      return;
    }
    if (result === UCP_RESULT_NOT_AUTHORIZED) {
      // openScale requestScaleUserConsent(): have the scale display the code.
      if (!s.pinDisplayRequested && this.userIndex >= 1) {
        s.pinDisplayRequested = true;
        this.writeVendor(
          s,
          CHR_VENDOR_USER_LIST,
          [(PIN_DISPLAY_BASE + this.userIndex) & 0xff],
          'consent-code display',
        );
      }
      bleLog.warn(
        `Sanitas SBF72: consent rejected for user index ${this.userIndex} with code ` +
          `${this.pin} (USER_NOT_AUTHORIZED). The scale now shows the code of that slot ` +
          'on its display: put it in `users[].beurer_pin`. If the slot is wrong, set ' +
          '`users[].beurer_user_index` to the one the log lists for your profile.',
      );
      return;
    }
    const why = UCP_RESULTS[result] ?? `0x${result.toString(16).padStart(2, '0')}`;
    bleLog.warn(`Sanitas SBF72: User Control Point rejected the consent (${why}).`);
  }

  private handleUserListFrame(data: Buffer): void {
    if (data.length === 0) return;
    const s = this.s;
    const status = data[0];
    if (status >= PIN_DISPLAY_BASE) {
      bleLog.debug(`Sanitas SBF72: consent-code display acknowledged [${hex(data)}]`);
      return;
    }
    if (status === LIST_END || status === LIST_NO_USER) {
      bleLog.debug(
        status === LIST_END
          ? `Sanitas SBF72: end of user-slot list (${s.slots.length} slot(s))`
          : 'Sanitas SBF72: the scale reports no stored user',
      );
      s.listDone?.();
      return;
    }
    const slot = parseSlot(data);
    if (!slot) {
      bleLog.debug(`Sanitas SBF72: short user-slot record [${hex(data)}], not decoded`);
      return;
    }
    s.slots.push(slot);
    bleLog.info(
      `Sanitas SBF72: user slot ${slot.index} "${slot.initials}" (born ${slot.year}-` +
        `${slot.month}-${slot.day}, ${slot.heightCm} cm, ${slot.gender}, ` +
        `activity ${slot.activityLevel})`,
    );
  }

  /**
   * Parse a BT SIG Body Composition Measurement (0x2A9C) notification, for a
   * caller that has no characteristic to name.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.sig.onBodyComposition(data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /** A 0x2A9C reading is the whole weigh-in; a 0x2A9D one waits for it. */
  isFinal(reading: ScaleReading): boolean {
    return this.sig.isFinal(reading);
  }

  onSessionEnd(): void {
    const s = this.s;
    if (s.consentSent && !s.consentAnswered && !s.readingEmitted) {
      bleLog.warn(
        `Sanitas SBF72: the scale never answered the consent for user index ` +
          `${this.userIndex}. If the link is not bonded the answer cannot arrive; ` +
          'otherwise check `users[].beurer_user_index` and `users[].beurer_pin`.',
      );
    }
    s.ended = true;
    s.listDone?.();
    this.stopConsentRetry(s);
    this.ctx = undefined;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const gatt = this.sig.compositionOf(reading);
    const waterPercent =
      gatt?.waterMassKg && reading.weight > 0
        ? (gatt.waterMassKg / reading.weight) * 100
        : undefined;

    return buildPayload(
      reading.weight,
      reading.impedance,
      {
        fat: gatt?.bodyFatPercent,
        water: waterPercent,
        muscle: gatt?.musclePct,
      },
      profile,
    );
  }
}

/** Current Time Service 0x2A2B payload (10 bytes). */
function buildCurrentTime(now = new Date()): number[] {
  const year = now.getFullYear();
  return [
    year & 0xff,
    (year >> 8) & 0xff,
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    ((now.getDay() + 6) % 7) + 1, // 1 = Monday .. 7 = Sunday
    0x00, // fractions256
    0x00, // adjust reason
  ];
}
