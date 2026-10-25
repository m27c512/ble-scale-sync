import type { SessionFixture } from '../../helpers/replay/session.js';
import { at, BCS, BCS_168, BCS_WITH_WEIGHT, WSS, WSS_168 } from './frames.js';

const LIST = '0001'; // vendor user list, service 0xFFFF
const UCP = '2a9f';

/**
 * Sanitas SBF72/73 sessions. No SBF72 capture exists; the SIG frames are the
 * ones the adapter test borrows from the #168 snoop of another SIG scale
 * (frames.ts has them and their rewrite). Same pairing as Standard GATT, with
 * 0x2A9C and 0x2A9F required and 0x2A9D optional. The connection sequence is
 * openScale's SanitasSbf72Handler: Current Time, the vendor user list on
 * 0xFFFF 0x0001, consent on 0x2A9F (re-sent every 5 s until answered), then
 * `00` on 0x0006 once it is accepted. Spacing invented.
 */
export const session: SessionFixture = {
  adapter: 'Sanitas SBF72/73',
  traces: {
    'sbf72-weight-then-composition': {
      provenance: 'derived',
      source: '#168 HCI snoop frames (not an SBF72); stamp year -> 2000, pair spacing invented',
      steps: [at(1000, WSS, WSS_168), at(1100, BCS, BCS_168)],
    },
    'sbf72-weight-only-hold-runs-out': {
      provenance: 'derived',
      source: '#168 HCI snoop 0x2A9D frame alone (not an SBF72); stamp year -> 2000',
      steps: [at(1000, WSS, WSS_168)],
    },
    'sbf72-composition-with-weight': {
      provenance: 'characterization',
      source: 'SIG BCS layout: flags 0x0600, 22.5 %, 500.0 ohm, 80.00 kg',
      steps: [at(1000, BCS, BCS_WITH_WEIGHT)],
    },
    'sbf72-user-list-consent-then-measurement': {
      provenance: 'characterization',
      source:
        'openScale SanitasSbf72Handler layout: slot 1 born 1996-05-15, 183 cm, male; ' +
        'end of list; consent SUCCESS; then the #168 frames (not an SBF72)',
      steps: [
        at(100, LIST, '0001524f42cc07050fb70003'),
        at(150, LIST, '01'),
        at(300, UCP, '200201'),
        at(1000, WSS, WSS_168),
        at(1100, BCS, BCS_168),
      ],
    },
  },
};
