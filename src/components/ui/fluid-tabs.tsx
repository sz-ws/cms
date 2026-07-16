"use client";

import { useState, type ReactNode, type FC } from "react";
import { motion } from "motion/react";
import { Landmark, Inbox, PieChart } from "lucide-react";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface FluidTabsProps {
  tabs?: TabItem[];
  defaultActive?: string;
  onChange?: (id: string) => void;
  compact?: boolean;
}

const DEFAULT_TABS: TabItem[] = [
  { id: "accounts", label: "Accounts", icon: <Landmark size={22} /> },
  { id: "deposits", label: "Deposits", icon: <Inbox size={22} /> },
  { id: "funds", label: "Funds", icon: <PieChart size={22} /> },
];

export const FluidTabs: FC<FluidTabsProps> = ({
  tabs = DEFAULT_TABS,
  defaultActive = tabs[0]?.id,
  onChange,
  compact = false,
}) => {
  // inline-flex + w-fit → pill hugs content; max-w-full → caps at parent width
  // when content overflows; overflow-x-auto + no-scrollbar → internal horizontal
  // scroll as the fallback (so callers can sit it inside any width container,
  // including narrow mobile, without buttons squashing or wrapping).
  const rootClass = compact
    ? "relative inline-flex w-fit max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-full border border-[#f1ece4] bg-[#F5F1EB] px-1 py-1 transition-colors no-scrollbar dark:border-neutral-800 dark:bg-neutral-900"
    : "relative inline-flex w-fit max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-full border-[1.6px] border-[#f5f1ebf4] bg-[#F5F1EB] px-1 py-1 transition-colors no-scrollbar sm:gap-2 dark:border-neutral-800 dark:bg-neutral-900";
  const buttonClass = compact
    ? "group relative shrink-0 rounded-full px-2.5 py-1.5 outline-none sm:px-3 sm:py-2"
    : "group relative shrink-0 rounded-full px-3 py-2.5 outline-none sm:px-4 sm:py-3.5";
  const contentClass = (isActive: boolean) =>
    `relative z-10 flex items-center gap-1.5 transition-colors duration-200 ${
      isActive
        ? "font-bold text-[#292926] dark:text-white"
        : "font-semibold text-[#585652] dark:text-neutral-500 group-hover:dark:text-neutral-300"
    }`;
  const labelClass = compact
    ? "text-[12px] tracking-tight whitespace-nowrap sm:text-[13px]"
    : "text-sm tracking-tight whitespace-nowrap sm:text-base";
  const [active, setActive] = useState<string>(defaultActive);

  const handleChange = (id: string) => {
    setActive(id);
    onChange?.(id);
  };

  return (
    <div className={rootClass}>
      {tabs.map((tab) => {
        const isActive = active === tab.id;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleChange(tab.id)}
            className={buttonClass}
          >
            {isActive && (
              <motion.div
                layoutId="active-pill"
                transition={{
                  type: "spring",
                  stiffness: 280,
                  damping: 25,
                  mass: 0.8,
                }}
                className="absolute inset-0 rounded-full border border-[#fefefe]/90 bg-gradient-to-b from-[#fefefe] to-gray-50/80 shadow-xs dark:border-neutral-600/50 dark:from-neutral-700 dark:to-neutral-800/90"
              />
            )}

            <motion.div
              transition={{
                duration: 0.3,
                ease: "easeOut",
              }}
              animate={{
                filter: isActive
                  ? ["blur(0px)", "blur(4px)", "blur(0px)"]
                  : "blur(0px)",
              }}
              className={contentClass(isActive)}
            >
              {tab.icon ? (
                <motion.div
                  animate={{ scale: isActive ? 1.03 : 1 }}
                  transition={{
                    scale: { type: "spring", stiffness: 300, damping: 15 },
                  }}
                  className="flex shrink-0 items-center justify-center"
                >
                  {tab.icon}
                </motion.div>
              ) : null}

              <span className={labelClass}>
                {tab.label}
              </span>
            </motion.div>
          </button>
        );
      })}
    </div>
  );
};
