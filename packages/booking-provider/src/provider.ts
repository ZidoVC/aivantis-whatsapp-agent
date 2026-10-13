import type {
  Appointment,
  AvailableSlotsRequest,
  CreateAppointmentInput,
  CreateContactInput,
  DoctorSite,
  HealthStatus,
  HoursBlock,
  LeadInput,
  ModifyAppointmentInput,
  ModifyContactInput,
  Patient,
  Slot,
  Treatment,
  WriteResult,
} from "./types";

/**
 * The single contract the agent depends on. Every concrete provider
 * (Mock, Optima, …) implements this; the agent never imports a provider directly.
 */
export interface BookingProvider {
  /** Liveness check. */
  healthCheck(): Promise<HealthStatus>;

  /** Free-text patient search (name / phone / id). */
  searchPatient(query: string): Promise<Patient[]>;

  /** Appointments for a specific patient, by CardID. */
  getPatientAppointments(cardId: string): Promise<Appointment[]>;

  /** Appointments across the clinic in an ISO date range (inclusive). */
  getAppointments(start: string, end: string): Promise<Appointment[]>;

  /** Bookable windows for a date range / doctors — the core call for the agent. */
  getAvailableSlots(req: AvailableSlotsRequest): Promise<Slot[]>;

  /** Doctor + site directory (source of `doctorCode`). */
  getDoctorsSites(): Promise<DoctorSite[]>;

  /** Configured hour-blocking definitions. */
  getHoursBlocking(): Promise<HoursBlock[]>;

  /** Treatment history for a patient. */
  getTreatments(patientId: string): Promise<Treatment[]>;

  createAppointment(input: CreateAppointmentInput): Promise<WriteResult>;
  modifyAppointment(input: ModifyAppointmentInput): Promise<WriteResult>;
  deleteAppointment(meetingId: string): Promise<WriteResult>;

  createContact(input: CreateContactInput): Promise<WriteResult>;
  modifyContact(input: ModifyContactInput): Promise<WriteResult>;

  /** Forward a lead to the backend. */
  addLead(input: LeadInput): Promise<WriteResult>;
}
