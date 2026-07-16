"use client";

import { motion } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type FC } from "react";

type ThemeConfig = {
  bg: string;
  button: string;
  dot: string;
  progress: string;
};

interface CarouselNavigatorProps {
  totalSlides?: number;
  autoDelay?: number;
  themes?: ThemeConfig[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
}

const DEFAULT_TOTAL_SLIDES = 4;
const DEFAULT_AUTO_DELAY = 5000;

const DEFAULT_THEMES: ThemeConfig[] = [
  {
    bg: "bg-zinc-100",
    button: "bg-zinc-900",
    dot: "bg-zinc-400",
    progress: "bg-zinc-900",
  },
  {
    bg: "bg-blue-50",
    button: "bg-blue-600",
    dot: "bg-blue-300",
    progress: "bg-blue-600",
  },
  {
    bg: "bg-green-50",
    button: "bg-green-600",
    dot: "bg-green-300",
    progress: "bg-green-600",
  },
  {
    bg: "bg-yellow-50",
    button: "bg-yellow-500",
    dot: "bg-yellow-300",
    progress: "bg-yellow-500",
  },
];

export const CarouselNavigator: FC<CarouselNavigatorProps> = ({
  totalSlides = DEFAULT_TOTAL_SLIDES,
  autoDelay = DEFAULT_AUTO_DELAY,
  themes = DEFAULT_THEMES,
  currentIndex,
  onIndexChange,
}) => {
  const theme = themes[currentIndex];

  const goPrev = () =>
    onIndexChange((currentIndex - 1 + totalSlides) % totalSlides);

  const goNext = () => onIndexChange((currentIndex + 1) % totalSlides);

  return (
    <motion.div
      animate={{
        backgroundColor: theme.bg.replace("bg-[", "").replace("]", ""),
      }}
      className="flex items-center justify-center gap-1 rounded-full px-4 py-3 transition-colors duration-300"
    >
      <ArrowButton
        onClick={goPrev}
        themeColor={theme.button}
        disabled={currentIndex === 0}
      >
        <ChevronLeft size={24} strokeWidth={3} />
      </ArrowButton>

      <div className="flex items-center gap-2 px-2">
        {Array.from({ length: totalSlides }).map((_, i) => (
          <Indicator
            key={i}
            isActive={i === currentIndex}
            theme={theme}
            autoDelay={autoDelay}
            onClick={() => onIndexChange(i)}
          />
        ))}
      </div>

      <ArrowButton onClick={goNext} themeColor={theme.button}>
        <ChevronRight size={24} strokeWidth={3} />
      </ArrowButton>
    </motion.div>
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ArrowButton = ({ children, onClick, themeColor, disabled }: any) => {
  return (
    <motion.button
      onClick={onClick}
      whileTap={{ scale: 0.9 }}
      className={`flex h-12 w-12 items-center justify-center rounded-full text-white shadow-sm transition-colors cursor-pointer duration-300 ${
        disabled ? "bg-gray-300 opacity-50" : themeColor
      }`}
    >
      {children}
    </motion.button>
  );
};

const Indicator = ({
  isActive,
  theme,
  autoDelay,
  onClick,
}: {
  isActive: boolean;
  theme: ThemeConfig;
  autoDelay: number;
  onClick: () => void;
}) => {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      layout
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      style={{ borderRadius: 24 }}
      className={`relative h-3 cursor-pointer  focus:outline-none ${
        isActive ? `w-12 ${theme.progress}` : `w-3 ${theme.dot}`
      } transition-colors duration-300`}
    >
      {isActive && (
        <motion.div
          initial={{ width: "0%" }}
          animate={{ width: "100%" }}
          transition={{ duration: autoDelay / 1000, ease: "linear" }}
          className="absolute inset-0 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.12)]"
        />
      )}
    </motion.button>
  );
};
