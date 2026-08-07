/**
 * Port of src/auth/roles.js — unchanged apart from module syntax.
 *
 * The three community tiers, in order of power. One place decides what each
 * name means so a route, a view and a query can never disagree.
 *
 *   member    — boards, drafts, comments.
 *   leader    — the whole admin console; may be permanent or time-boxed
 *               (users.role_expires_at, UTC ISO; NULL = permanent).
 *   architect — one per board. Every leader power, and the only tier that can
 *               move anyone downward: demote a leader, deactivate a leader,
 *               force a leader's reset code. The architect itself cannot be
 *               deactivated, demoted, deleted or reset by anyone — the only way
 *               out of the chair is to hand it over (POST /admin/members/transfer).
 *
 * "Leader" in the UI means "leader or architect": an architect is a leader with
 * more, never less, so every existing isLeader / requireLeader check keeps
 * working for them.
 */

export const MEMBER = 'member';
export const LEADER = 'leader';
export const ARCHITECT = 'architect';

export const ROLES = [MEMBER, LEADER, ARCHITECT];

/** Roles that unlock /admin and every leader-level moderation power. */
export const LEADER_ROLES = new Set([LEADER, ARCHITECT]);

export const isRole = (role) => ROLES.includes(role);
export const isLeaderRole = (role) => LEADER_ROLES.has(role);
export const isArchitectRole = (role) => role === ARCHITECT;

/** Convenience for the user-object form the routes actually hold. */
export const isLeaderUser = (user) => !!user && isLeaderRole(user.role);
export const isArchitectUser = (user) => !!user && isArchitectRole(user.role);

/** "ARCHITECT" / "LEADER" / "MEMBER" for badges. */
export const roleLabel = (role) => (isRole(role) ? role.toUpperCase() : String(role || '').toUpperCase());
