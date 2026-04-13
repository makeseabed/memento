const OBSERVER_LOCALE = "en-US";
const FALLBACK_TIME_ZONE = "UTC";

export interface ObserverDateParts {
  timeZone: string;
  date: string;
  dayName: string;
  time: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function getObserverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter) return formatter;

  formatter = new Intl.DateTimeFormat(OBSERVER_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function formatObserverDateParts(date: Date, timeZone = getObserverTimeZone()): ObserverDateParts {
  const parts = getFormatter(timeZone).formatToParts(date);

  return {
    timeZone,
    date: `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}`,
    dayName: getPart(parts, "weekday"),
    time: `${getPart(parts, "hour")}:${getPart(parts, "minute")}`,
  };
}

export function formatObserverDate(date: Date, timeZone = getObserverTimeZone()): string {
  return formatObserverDateParts(date, timeZone).date;
}

export function formatObserverTime(date: Date, timeZone = getObserverTimeZone()): string {
  return formatObserverDateParts(date, timeZone).time;
}
