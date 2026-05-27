/**
 * Tipos parciales de la base (Supabase). Ampliar cuando se generen los tipos completos.
 */

export type MtgColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
export type EventType = 'draft' | 'tournament' | 'pepidraft';
export type EventStatus =
  | 'scheduled'
  | 'drafting'
  | 'playing'
  | 'completed'
  | 'cancelled';

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatar_path: string | null;
  created_by: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type WorkspaceMember = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'organizer' | 'member';
  joined_at: string;
};

export type WorkspaceJoinRequestStatus = 'pending' | 'approved' | 'rejected';

export type WorkspaceJoinRequest = {
  id: string;
  workspace_id: string;
  user_id: string;
  message: string | null;
  status: WorkspaceJoinRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};

export type Cube = {
  id: string;
  workspace_id: string;
  name: string;
  cubecobra_url: string | null;
  card_count: number | null;
  notes: string | null;
  avatar_path: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type Venue = {
  id: string;
  workspace_id: string;
  name: string;
  address: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type DraftEvent = {
  id: string;
  workspace_id: string;
  status: EventStatus;
  event_type: EventType;
  champion_user_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type EventParticipant = {
  id: string;
  event_id: string;
  user_id: string;
  role: 'player' | 'ghost' | 'exile';
  exile_borrowed_from_user_id: string | null;
  self_evaluation: number | null;
  rotated_avatar_id: string | null;
  joined_at: string;
};

export type ParticipantColor = {
  id: string;
  participant_id: string;
  color: MtgColor;
};

export type Pairing = {
  id: string;
  event_id: string;
  participant_a_id: string;
  participant_b_id: string;
  official_winner_participant_id: string | null;
  super_cup_winner_participant_id: string | null;
  data_source: 'app' | 'imported_notebook' | 'manual_entry';
  created_at: string;
};

export type Match = {
  id: string;
  pairing_id: string;
  match_number: number;
  match_type: 'draft' | 'revenge' | 'final' | 'two_headed_giant' | 'tiebreak';
  winner_participant_id: string | null;
  life_tracker_user_id: string | null;
  ended_by_surrender: boolean;
  status: 'in_progress' | 'completed' | 'aborted';
  starting_life_a: number;
  starting_life_b: number;
  started_at: string;
  ended_at: string | null;
  data_source: 'app' | 'imported_notebook' | 'manual_entry';
};

export type LifeEvent = {
  id: string;
  match_id: string;
  participant_id: string;
  delta: number;
  resulting_life: number;
  occurred_at: string;
  is_undo: boolean;
  undoes_event_id: string | null;
};

// ── Vistas de estadísticas cross-event ─────────────────────────────────────

export type PlayerWorkspaceStat = {
  user_id: string;
  workspace_id: string;
  pairings_won: number;
  pairings_lost: number;
  pairings_pending: number;
  draft_matches_won: number;
  draft_matches_lost: number;
  revenge_matches_won: number;
  revenge_matches_lost: number;
  super_cups_won: number;
  championships: number;
  events_as_player: number;
  events_as_ghost: number;
  avg_match_duration_minutes: number | null;
};

export type ParticipantEventPlacement = {
  participant_id: string;
  event_id: string;
  user_id: string;
  workspace_id: string;
  event_name: string;
  event_ended_at: string | null;
  event_status: EventStatus;
  scheduled_for: string | null;
  bo3_won: number;
  bo3_completed: number;
  matches_won: number;
  matches_completed: number;
  placement: number;
  total_players: number;
};

export type PlayerColorStat = {
  user_id: string;
  workspace_id: string;
  color: MtgColor;
  times_played: number;
  total_color_picks: number;
  percentage: number;
};
