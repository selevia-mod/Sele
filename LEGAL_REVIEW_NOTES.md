# Selebox — Legal Review Notes

_Prepared: April 28, 2026_

This document is for the Philippine attorney reviewing Selebox's `terms.html`, `privacy.html`, and `refund.html` before launch on `selebox.com`.

## Business context

- Selebox is a social platform with three content types: posts, videos, and books.
- Operates in two surfaces: **mobile app** (legacy, Appwrite-backed) and **web** (new, Supabase + Vercel).
- Web launch target: `selebox.com` (currently live for testing at `sele-gray.vercel.app`).
- Two virtual currencies: **Coins** (paid with real money via HitPay) and **Stars** (earned by watching mobile ads).
- Target audience includes Philippine users primarily, with some international.
- Ages: minimum age set at **16** in both Terms and Privacy.

## Decisions still required from Selebox

These appear as `[BRACKETS]` in the documents and need to be filled before going live:

1. **`TOS WEB PUBLISHING`** — DTI sole proprietorship, SEC corporation, or other legal entity name.
2. **`MALOLOS, BULACAN`** — physical registered business address (required by PH DPA for transparency, and for receipts under BIR rules).
3. **`CHARLES SANTOS`** — Data Protection Officer name. PH businesses processing personal data must designate and register a DPO with the National Privacy Commission. If Selebox has not done this, do it before launch (`npc.gov.ph` → Register a DPO).
4. **`BULACAN`** in Terms §16 — typically the city where the business is registered (e.g. Quezon City, Makati, Pasig).
5. **Author monetization clause in Terms §7** — Currently says "[NOT YET AVAILABLE / SUBJECT TO A SEPARATE AUTHOR EARNINGS POLICY]". Decide which version to keep based on whether Authors can withdraw earnings.

## Items the lawyer should confirm

### Mandatory under Philippine law
- **DPA compliance**: confirm Privacy Policy meets all transparency requirements under RA 10173 §16 (data subject rights) and IRR §34 (privacy notice content).
- **NPC Circular 16-01**: confirm breach-notification language in Privacy §10 ("we will notify you and the National Privacy Commission within the timeframes required by Philippine law") matches the 72-hour rule and substantive content requirements.
- **DPO registration**: verify Selebox has registered or will register the DPO with NPC.
- **Consumer Act of the Philippines (RA 7394)**: confirm Refund Policy doesn't violate consumer protections, especially around digital goods.
- **IP Code (RA 8293)**: confirm copyright takedown procedure in Terms §9 is compliant; flag if Selebox needs to register as a service provider for safe-harbor benefits.
- **BIR record-keeping**: confirm 10-year retention for transaction records is correct (typically 10 years per NIRC §235).

### Strongly recommended additions
- **Anti-Money Laundering Act (RA 9160) compliance** — if HitPay flags any transactions, do we have obligations? May not apply at our transaction size, but worth confirming.
- **Cybercrime Prevention Act (RA 10175)** — does our content moderation framework adequately cover obligations under this law (e.g. removal of cyber-libel, cybersex, etc.)?
- **SIM Registration Act (RA 11934)** — does not directly apply but worth confirming our use of phone numbers (if any) is OK.

### Optional / nice-to-have
- Class action waiver — not common in PH but could be added.
- Mandatory arbitration clause — uncommon for consumer apps in PH.
- Force majeure scope — review for completeness.
- Limitation of liability cap (currently ₱1,000 or 12 months of fees) — confirm enforceable under PH law.

## Items intentionally not included

- **CCPA-specific "Do Not Sell My Personal Information" link** — we don't sell data, and California users are not a primary audience. The Privacy Policy states this explicitly.
- **Cookie consent banner** — we use only strictly necessary cookies (auth session) and functional cookies (preferences), no third-party advertising trackers on the website. Under PH DPA and EU ePrivacy guidance, a banner is not strictly required for these uses, but may be added later if marketing trackers are introduced.
- **Stars purchase / withdrawal terms** — Stars cannot be purchased and have no cash value. Any future change here would require an update to both Terms §6 and the Refund Policy.
- **Author payout terms** — placeholder only; will be a separate document if/when this feature ships.

## How the documents are wired into the product

- The auth screen of the website (`index.html`) shows a required checkbox: *"I agree to the Terms of Service and Privacy Policy"*. Users cannot sign in without checking it.
- Links to all three documents (`/terms.html`, `/privacy.html`, `/refund.html`) appear next to the checkbox and open in new tabs.
- The Service has a separate Refund Policy that is incorporated by reference in the Terms and consented to alongside them.
- Acceptance is captured at every fresh sign-in. Existing users remain bound by the version in effect when they last signed in.

## Cost / time estimate for review

A typical engagement for this scope (review three policy docs, flag issues, draft amendments, confirm PH-specific compliance) is:

- **Junior-mid attorney from a small/medium PH firm**: 2-4 hours, ₱8,000-₱20,000.
- **Specialized data privacy / fintech firm (e.g. Cruz Marcelo, ACCRALAW, Quisumbing Torres)**: 5-8 hours, ₱40,000-₱80,000+.

For a startup at Selebox's stage, the junior-mid route is sufficient. The lawyer should be familiar with **RA 10173 (Data Privacy Act)** and **RA 7394 (Consumer Act)**.

## Questions to ask the lawyer

1. Are we required to register Selebox with NPC as a Personal Information Controller, beyond just DPO registration?
2. Does our 10-year transaction-data retention satisfy BIR requirements for digital-goods sellers, or is there a different rule?
3. Is the Refund Policy's "all sales final" baseline (with limited exceptions) enforceable under the Consumer Act for digital goods?
4. Should we add a clause about Selebox being a "merchant of record" vs HitPay being the merchant of record? (Affects who is liable for refunds and who issues OR/CR receipts under BIR rules.)
5. Are we required to issue an OR/CR (official receipt / collection receipt) for every Coin purchase, and if so, can HitPay be designated to issue it on our behalf?
6. Does our content moderation policy adequately protect us from secondary liability for user-uploaded copyright violations?
