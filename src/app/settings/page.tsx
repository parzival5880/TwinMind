"use client";

import Link from "next/link";
import { SettingsForm } from "@/components/SettingsForm";
import { useSettings } from "@/hooks/useSettings";

export default function SettingsPage() {
  const {
    defaultSettings,
    feedback,
    fieldErrors,
    isLoaded,
    isSaving,
    resetSettings,
    settings,
    updateSettings,
  } = useSettings();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="rounded-[2rem] border border-white/50 bg-white/80 p-6 shadow-[0_30px_80px_rgba(15,23,42,0.12)] backdrop-blur">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-cyan-700">
              Settings
            </p>
            <div className="space-y-2">
              <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                Configure prompts, API access, and context limits.
              </h1>
              <p className="max-w-3xl text-base leading-7 text-slate-600">
                This page uses the same settings form as the in-meeting modal, backed by
                localStorage so your values persist after refresh.
              </p>
            </div>
          </div>

          <Link
            className="inline-flex w-fit items-center justify-center rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            href="/"
          >
            Back to Meeting
          </Link>
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/50 bg-white/80 p-6 shadow-[0_30px_80px_rgba(15,23,42,0.12)] backdrop-blur">
        <SettingsForm
          defaultSettings={defaultSettings}
          fieldErrors={fieldErrors}
          feedback={feedback}
          isLoaded={isLoaded}
          isSaving={isSaving}
          onReset={resetSettings}
          onSave={updateSettings}
          settings={settings}
        />
      </section>
    </main>
  );
}
