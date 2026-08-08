'use strict';

/**
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

const MEMBER = 'member';
const LEADER = 'leader';
const ARCHITECT = 'architect';

const ROLES = [MEMBER, LEADER, ARCHITECT];

/** Roles that unlock /admin and every leader-level moderation power. */
const LEADER_ROLES = new Set([LEADER, ARCHITECT]);

const isRole = (role) => ROLES.includes(role);
const isLeaderRole = (role) => LEADER_ROLES.has(role);
const isArchitectRole = (role) => role === ARCHITECT;

/** Convenience for the user-object form the routes actually hold. */
const isLeaderUser = (user) => !!user && isLeaderRole(user.role);
const isArchitectUser = (user) => !!user && isArchitectRole(user.role);

/** "ARCHITECT" / "LEADER" / "MEMBER" for badges. */
const roleLabel = (role) => (isRole(role) ? role.toUpperCase() : String(role || '').toUpperCase());

/**
 * The god-level account is hidden away, not deleted: an architect row is
 * invisible in every user LISTING and PICKER to every viewer except the
 * architect looking at their own — the members page still has to host the
 * transfer flow. `rows` must carry `.role` and `.id` (whatever `users.list` /
 * `users.listActive` already select).
 *
 * `keepIds` pins specific ids back into a filtered result even when they are
 * the architect — for a <select> re-rendering a meeting the architect already
 * hosts, so a leader who is not the architect editing some OTHER field on that
 * meeting does not silently blank the host out from under them by re-posting a
 * form whose dropdown no longer contains the person actually assigned.
 */
const visibleUsers = (rows, viewer, keepIds = []) => {
  if (isArchitectUser(viewer)) return rows;
  const keep = new Set(keepIds.filter((id) => id !== null && id !== undefined).map(Number));
  return rows.filter((r) => !isArchitectRole(r.role) || keep.has(Number(r.id)));
};

module.exports = {
  MEMBER,
  LEADER,
  ARCHITECT,
  ROLES,
  LEADER_ROLES,
  isRole,
  isLeaderRole,
  isArchitectRole,
  isLeaderUser,
  isArchitectUser,
  roleLabel,
  visibleUsers,
};
