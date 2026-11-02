// Upstream ships these types but its exports map omits the types entry.
// Keep the small interface used here explicit until upstream fixes that map.
declare module 'date-holidays-parser' {
  export default class Holidays {
    constructor(data: object, country: string, state: string, region?: string);
    setLanguages(languages: string | string[]): void;
    setTimezone(timezone: string): void;
    getHolidays(year: number): Array<{ date: string; type: string; name: string }>;
  }
}
