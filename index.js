/**
 * Host half of the quota pill bundle.
 *
 * The pill reads only Client-side data: the `account` Remote namespace for the
 * Platform balance and the `tokenUsage` Session projection. No Host service is
 * needed, so this half contributes nothing and exists because a bundle patch row
 * names a resolvable plugin module.
 */
export function apply() {}
