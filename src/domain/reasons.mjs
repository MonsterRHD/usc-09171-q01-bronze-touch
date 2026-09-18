// 决策原因码：每一次拒绝、取消、改派都携带原因之一，供主管向现场解释。

export const REASONS = {
  unknown_replica: "复刻件尚未登记",
  unknown_session: "场次不存在",
  session_cancelled: "场次已取消",
  session_full: "场次容量已满",
  replica_conflict: "该复刻件在此时段已有其他预约",
  booked_by_other: "该复刻件本场次已由他人预约",
  assistance_mismatch: "观众辅助需求超出本场次支持范围",
  restriction_conflict: "观众辅助需求与展品可触限制冲突",
  closed: "临时闭馆中，暂停放行与预约",
  recalled: "展品已被保管员召回",
  suspended: "承重传感器读数超限，展品已停用",
  already_held: "展品当前由他人占用",
  cleaning_pending: "展品归还后尚未完成清洁",
  cooldown_active: "清洁后冷却时间未结束",
  inspection_pending: "展品尚未完成检查",
  late_arrival: "超过场次签到宽限期，预约已失效",
  load_exceeded: "承重读数超过登记上限",
};

// 观众辅助需求与展品可触限制的静态冲突表。
export const NEED_RESTRICTION_CONFLICTS = {
  one_hand: ["two_hands_required"],
  lift_assist: ["no_lifting"],
  bare_hands: ["gloves_required"],
};
