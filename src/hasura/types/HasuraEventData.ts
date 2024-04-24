export type HasuraEventData<T extends string | number | symbol = string> = {
  op: "INSERT" | "UPDATE" | "DELETE";
  old: Record<T, string>;
  new: Record<T, string>;
};
