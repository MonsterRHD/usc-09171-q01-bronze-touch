// 角色鉴权：Bearer 令牌映射到角色与人员引用。
// 角色：guide（讲解员）、curator（保管员）、supervisor（现场主管）、cleaner（清洁组）、device（扫码/传感终端）。

export function authenticate(req, config) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return null;
  const principal = config.tokens[match[1]];
  return principal ? { role: principal.role, ref: principal.ref } : null;
}

export function roleAllowed(principal, roles) {
  if (roles === "any") return true;
  return roles.includes(principal.role);
}
