import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { ticketSchema, type RuntimeTicket, type SignedTicket } from '../integration/protocol.js';

export class ArtifactSigner {
  private readonly key: KeyObject;
  constructor(privateKeyPem: string) {
    this.key = createPrivateKey(privateKeyPem);
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signing key required.');
  }
  sign(ticket: RuntimeTicket): SignedTicket {
    const payload = JSON.stringify(ticketSchema.parse(ticket));
    return { payload, signature: sign(null, Buffer.from(payload), this.key).toString('base64') };
  }
}
