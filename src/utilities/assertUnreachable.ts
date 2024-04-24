/**
 * Helper for switch cases when using enums to make sure they are correctly satisfied
 */
export function assertUnreachable(_case: never): never {
  throw Error(`not handled case ${_case}`);
}
