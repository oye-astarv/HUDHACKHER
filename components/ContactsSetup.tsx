"use client";

import { useState } from "react";
import { normalisePhone, pinVerifier, type Contact, type Profile } from "@/lib/tracking";

/**
 * Trusted contacts + 4-digit Safety PIN. Used as the first-launch onboarding
 * and as the Network tab. Everything stays in this browser's localStorage.
 */
export default function ContactsSetup({
  profile,
  onSave,
  onCancel,
  onboarding,
}: {
  profile: Profile | null;
  onSave: (p: Profile) => void;
  onCancel?: () => void;
  onboarding?: boolean;
}) {
  const [ownerName, setOwnerName] = useState(profile?.ownerName ?? "");
  const [contacts, setContacts] = useState<Contact[]>(
    profile?.contacts.length ? profile.contacts : [{ name: "", phone: "" }]
  );
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<Contact>) =>
    setContacts((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const save = async () => {
    setError(null);
    if (!ownerName.trim()) return setError("Add your first name so contacts know who the alert is from.");

    const cleaned: Contact[] = [];
    for (const c of contacts) {
      if (!c.name.trim() && !c.phone.trim()) continue;
      const phone = normalisePhone(c.phone);
      if (!c.name.trim() || !phone) {
        return setError(`Check ${c.name.trim() || "each contact"}: needs a name and a mobile number, e.g. 07700 900123.`);
      }
      cleaned.push({ name: c.name.trim().slice(0, 30), phone });
    }
    if (cleaned.length === 0) return setError("Add at least one trusted contact.");

    let verifier = profile?.pinVerifier ?? "";
    if (pin || !verifier) {
      if (!/^\d{4}$/.test(pin)) return setError("Choose a 4-digit Safety PIN.");
      if (pin !== pin2) return setError("The two PINs don't match.");
      if (/^(\d)\1{3}$/.test(pin) || pin === "1234") return setError("Pick a PIN that's harder to guess than that.");
      verifier = await pinVerifier(pin);
    }

    onSave({ ownerName: ownerName.trim().slice(0, 40), contacts: cleaned, pinVerifier: verifier });
    setPin("");
    setPin2("");
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {onboarding ? "10-second setup" : "Trusted network"}
        </p>
        <h2 className="mt-1 text-xl font-bold">Who should we alert?</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
          One tap on SOS sends them a text with your live location and the safe haven you are
          walking to. No account needed on their side, and this stays on your phone.
        </p>
      </div>

      <Field label="Your first name">
        <input
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          placeholder="e.g. Sarah"
          autoComplete="given-name"
          className="ss-input"
        />
      </Field>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Trusted contacts (up to 3)
        </p>
        {contacts.map((c, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={c.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Name"
              className="ss-input w-[38%]"
              aria-label={`Contact ${i + 1} name`}
            />
            <input
              value={c.phone}
              onChange={(e) => update(i, { phone: e.target.value })}
              placeholder="07700 900123"
              inputMode="tel"
              autoComplete="tel"
              className="ss-input flex-1"
              aria-label={`Contact ${i + 1} mobile`}
            />
            {contacts.length > 1 && (
              <button
                onClick={() => setContacts((cs) => cs.filter((_, j) => j !== i))}
                className="rounded-lg border border-edge px-2 text-slate-500"
                aria-label={`Remove contact ${i + 1}`}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {contacts.length < 3 && (
          <button
            onClick={() => setContacts((cs) => [...cs, { name: "", phone: "" }])}
            className="text-[12px] font-semibold text-safe"
          >
            + Add another contact
          </button>
        )}
        <p className="text-[10px] leading-relaxed text-slate-500">
          Texted from a Twilio number. Trial accounts can only message numbers verified in the
          Twilio console.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Safety PIN {profile?.pinVerifier ? "(leave blank to keep current)" : ""}
        </p>
        <div className="flex gap-2">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            type="password"
            placeholder="4 digits"
            className="ss-input flex-1 text-center tracking-[0.4em]"
            aria-label="New Safety PIN"
          />
          <input
            value={pin2}
            onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            type="password"
            placeholder="repeat"
            className="ss-input flex-1 text-center tracking-[0.4em]"
            aria-label="Repeat Safety PIN"
          />
        </div>
        <p className="text-[10px] text-slate-500">
          Ending an alert needs this PIN, so nobody can grab your phone and silence it.
        </p>
      </div>

      {error && <p className="rounded-lg border border-fast/40 bg-fast/10 px-3 py-2 text-[12px] text-red-300">{error}</p>}

      <div className="flex gap-2">
        {onCancel && (
          <button onClick={onCancel} className="flex-1 rounded-xl border border-edge py-3 text-sm font-semibold text-slate-300">
            Cancel
          </button>
        )}
        <button onClick={save} className="flex-[2] rounded-xl bg-safe py-3 text-sm font-bold text-ink">
          {onboarding ? "Save and continue" : "Save network"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}
