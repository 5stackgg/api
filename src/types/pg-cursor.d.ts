declare module "pg-cursor" {
  import { EventEmitter } from "events";

  interface Cursor extends EventEmitter {
    read(
      rows: number,
      callback?: (err: Error | null, rows: any[]) => void,
    ): Promise<any[]>;
    close(callback?: (err?: Error) => void): Promise<void>;
  }

  interface CursorConstructor {
    new (text: string, values?: any[]): Cursor;
  }

  const Cursor: CursorConstructor;
  export = Cursor;
}

