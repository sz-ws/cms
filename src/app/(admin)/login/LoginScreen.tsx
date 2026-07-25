"use client";

import { useState } from "react";
import { TextMorph } from "torph/react";
import { LoginAsciiField } from "./LoginAsciiField";
import { LoginForm, type LoginProviderButton } from "./LoginForm";

export function LoginScreen({
  siteTitle,
  next,
  providers,
  oauthError,
}: {
  siteTitle: string;
  next?: string;
  providers?: LoginProviderButton[];
  oauthError?: string;
}) {
  const [phase, setPhase] = useState<"loading" | "playing" | "held">(
    "loading",
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fbfaf9] text-black antialiased selection:bg-black selection:text-white">
      <LoginAsciiField onPhase={setPhase} />

      {/* corner captions */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-6">
        <div className="flex items-start justify-between text-[12px] text-black/40">
          <span className="font-medium text-black/55">{siteTitle}</span>
          <span className="flex items-center gap-1.5">
            <span
              className={
                phase === "playing"
                  ? "flex size-3 items-center justify-center rounded-full border border-black/50"
                  : "flex size-3 items-center justify-center rounded-full border border-black/25"
              }
            >
              {/* 靜態點:playing 用實心黑、held 退淡 —— 不用 pulse(設計紅線)。 */}
              <span
                className={
                  phase === "playing"
                    ? "size-1 rounded-full bg-black"
                    : "size-1 rounded-full bg-black/35"
                }
              />
            </span>
            <TextMorph respectReducedMotion>
              {phase === "playing" ? "blooming" : "held"}
            </TextMorph>
          </span>
        </div>
        <div className="flex items-end justify-between font-mono text-[11px] text-black/30">
          <span>dither · ascii · one shot</span>
          <a
            href="https://okuso.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto text-black/30 underline decoration-black/10 underline-offset-2 transition-colors hover:text-black/55 hover:decoration-black/30"
          >
            sz.ws cms · @kuosuko
          </a>
        </div>
      </div>

      {/* centered form */}
      <main className="relative z-20 flex min-h-screen items-center justify-center px-5 py-20">
        <LoginForm
          next={next}
          siteTitle={siteTitle}
          providers={providers}
          oauthError={oauthError}
        />
      </main>
    </div>
  );
}
