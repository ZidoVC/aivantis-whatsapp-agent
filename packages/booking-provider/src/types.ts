/**
 * Clean, provider-agnostic domain model + configuration for the booking layer.
 *
 * Nothing here references Optima field names or wire formats. Conventions:
 *   - dates are ISO `YYYY-MM-DD`
 *   - times are `HH:MM:SS` (24h)
 *   - durations are whole minutes (number)
 *   - ids are strings
 *
 * Domain objects carry an optional `raw` (the untyped provider payload) so that,
 * during early integration, real Optima responses can be inspected and the Zod
 * response schemas hardened without changing the agent-facing shape.
 */

export type ProviderKind = "mock" | "optima";

export type Gender = "unknown" | "male" | "female";

/** Role of a service provider (staff member). */
export type ProviderRole = "consultation" | "nurse" | "doctor";

/** Whether an appointment is a consultation or an actual treatment. */
export type AppointmentType = "consultation" | "treatment";

export interface Patient {
  /** Optima CardID, as a string. Stable patient identifier. */
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone?: string;
  idNumber?: string;
  email?: string;
  gender?: Gender;
  /** ISO date `YYYY-MM-DD`. */
  birthDate?: string;
  raw?: unknown;
}

export interface Appointment {
  /** Optima meetingId / AppointmentID, as a string. */
  id: string;
  patientId?: string;
  patientName?: string;
  doctorCode?: string;
  providerId?: number;
  siteCode?: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM:SS` (24h). */
  startTime: string;
  durationMinutes?: number;
  /** consultation vs treatment (drives the gating layer). */
  type?: AppointmentType;
  /** Which treatment this appointment is for (code from the treatments catalog). */
  treatmentCode?: string;
  /** True when this appointment is part of an active treatment series. */
  activeSeries?: boolean;
  /** True once the appointment has taken place. */
  completed?: boolean;
  subject?: string;
  remarks?: string;
  raw?: unknown;
}

export interface Slot {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM:SS` (24h). */
  startTime: string;
  /** `HH:MM:SS` (24h), when known. */
  endTime?: string;
  durationMinutes?: number;
  doctorId?: number;
  doctorCode?: string;
  providerName?: string;
  role?: ProviderRole;
  treatmentCode?: string;
  siteId?: number;
  raw?: unknown;
}

export interface DoctorSite {
  doctorId?: number;
  doctorCode?: string;
  doctorName?: string;
  /** Role of this provider: consultation / nurse / doctor. */
  role?: ProviderRole;
  /** Treatment codes this provider is qualified to perform. */
  treatments?: string[];
  siteId?: number;
  siteCode?: string;
  siteName?: string;
  raw?: unknown;
}

export interface Treatment {
  id?: string;
  /** Stable treatment code (used by slots / gating), e.g. "botox". */
  code?: string;
  name?: string;
  /** Length of the treatment in minutes. */
  durationMinutes?: number;
  /** Optional gap/prep time (minutes) reserved before/around this treatment. */
  bufferMinutes?: number;
  /** Which provider role may perform it; undefined = not yet assigned. */
  requiredRole?: ProviderRole;
  /** ISO date `YYYY-MM-DD` (for a patient's treatment history entry). */
  date?: string;
  raw?: unknown;
}

export interface HoursBlock {
  doctorId?: number;
  siteId?: number;
  /** ISO date `YYYY-MM-DD` when the block is date-specific. */
  date?: string;
  /** `HH:MM:SS` (24h). */
  startTime?: string;
  /** `HH:MM:SS` (24h). */
  endTime?: string;
  reason?: string;
  raw?: unknown;
}

export interface HealthStatus {
  ok: boolean;
  details?: Record<string, string>;
}

/**
 * Result of a write operation. The Optima adapter does not document its write
 * response bodies, so `raw` is always present; `ok`/`id` are best-effort.
 */
export interface WriteResult {
  ok: boolean;
  /** New/affected entity id when the provider returns one (e.g. created meetingId / cardId). */
  id?: string;
  message?: string;
  raw: unknown;
}

/* --------------------------------- inputs --------------------------------- */

export interface AvailableSlotsRequest {
  /** ISO date `YYYY-MM-DD`. */
  start: string;
  /** ISO date `YYYY-MM-DD`. */
  end: string;
  /** Treatment code — determines required role, duration and buffer. */
  treatmentCode?: string;
  /** Restrict to a single provider by numeric id. */
  providerId?: number;
  doctorIds?: number[];
  minDurationMinutes?: number;
  siteId?: number;
  /** When true, providers that support it include blocking/opening rules in `raw`. */
  debug?: boolean;
}

export interface CreateAppointmentInput {
  doctorCode: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM:SS` (24h). */
  startTime: string;
  durationMinutes: number;
  siteCode?: string;
  /** consultation vs treatment. */
  type?: AppointmentType;
  treatmentCode?: string;
  subject?: string;
  cellPhone?: string;
  firstName?: string;
  lastName?: string;
  /** Existing patient CardID; omit for a new/anonymous booking. */
  cardId?: string;
  remarks?: string;
  idNumber?: string;
  /** ISO date `YYYY-MM-DD`. */
  birthDate?: string;
  gender?: Gender;
  insuranceCompany?: string;
  colorInt?: string;
  data1?: string;
  data2?: string;
  data3?: string;
  data4?: string;
  data5?: string;
}

export interface ModifyAppointmentInput {
  meetingId: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM:SS` (24h). */
  startTime: string;
  durationMinutes: number;
  subject?: string;
  colorInt?: string;
  doctorCode?: string;
  remarks?: string;
}

export interface ContactInput {
  firstName?: string;
  lastName?: string;
  cellPhone?: string;
  email?: string;
  insuranceCompany?: string;
  freeField1?: string;
  freeField2?: string;
  freeField3?: string;
  freeField4?: string;
  freeField5?: string;
  remarks?: string;
}

export interface CreateContactInput extends ContactInput {
  /** Optional CardID; a new contact is created when omitted. */
  cardId?: string;
}

export interface ModifyContactInput extends ContactInput {
  /** CardID is required to identify the contact to update. */
  cardId: string;
}

export interface LeadInput {
  optimaId?: string;
  source?: string;
  campaign?: string;
  name?: string;
  phone?: string;
  email?: string;
  subject?: string;
  /** ISO date `YYYY-MM-DD`. */
  birthDate?: string;
  state1?: string;
  state2?: string;
  doctor?: string;
  reminder?: string;
  externalId?: string;
}

/* ------------------------------ configuration ----------------------------- */

export interface OptimaCredentials {
  /** Base URL of the Optima WS Adapter, including the `/api2` prefix (e.g. `https://host/api2`). */
  baseUrl: string;
  username: string;
  password: string;
  /** Optima company number, sent on every command. */
  company: string;
  /** Per-request timeout in ms. Defaults to 20000. */
  timeoutMs?: number;
}

export interface BookingProviderConfig {
  /** Which implementation to use. Defaults to `process.env.BOOKING_PROVIDER`, then `"mock"`. */
  provider?: ProviderKind;
  /** Required when provider === "optima". Sourced per-tenant from the `business` row. */
  optima?: OptimaCredentials;
}
