/**
 * In-memory BookingProvider used for agent development (DemoClinic clinic model).
 *
 * Deterministic, realistic (Hebrew-context) data with a mutable in-process store.
 * The staff→treatment mapping, treatment catalog (durations/buffers/roles) and the
 * weekly SHIFT SCHEDULE are declared as plain config at the top so the real clinic
 * data can be swapped in without touching the logic. Availability is computed
 * DYNAMICALLY from the shift schedule — there is no fixed daily quota.
 *
 * NOTE (open items — kept configurable, not hard-coded, per the build brief):
 *  - Filler treatments (lips/nose/chin/…) have no confirmed provider → requiredRole
 *    left undefined ("unassigned"); they yield no self-service slots.
 *  - Tuesday / Friday hours are unconfirmed vs. the website → editable in SHIFTS.
 */

import type { BookingProvider } from "../provider";
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
  ProviderRole,
  Slot,
  Treatment,
  WriteResult,
} from "../types";
import { BookingError } from "../errors";

const pad = (n: number): string => String(n).padStart(2, "0");

/* --------------------------- treatment catalog ---------------------------- */
// duration/buffer are mock placeholders — easily replaced with real clinic values.

const NURSE_TREATMENTS: Treatment[] = [
  { code: "morpheus8", name: "מורפאוס 8", durationMinutes: 60, bufferMinutes: 15, requiredRole: "nurse" },
  { code: "smas_lifting", name: "SMAS ליפטינג", durationMinutes: 60, requiredRole: "nurse" },
  { code: "plasma", name: "פלזמה", durationMinutes: 45, requiredRole: "nurse" },
  { code: "skin_renewal_sr", name: "חידוש עור / לייזר SR", durationMinutes: 45, requiredRole: "nurse" },
  { code: "hair_removal", name: "הסרת שיער", durationMinutes: 30, requiredRole: "nurse" },
  { code: "cryo_fat", name: "הקפאת שומן בקור", durationMinutes: 60, requiredRole: "nurse" },
  { code: "rf", name: "גלי רדיו RF", durationMinutes: 45, requiredRole: "nurse" },
  { code: "geneo", name: "Geneo", durationMinutes: 45, requiredRole: "nurse" },
];

const DOCTOR_TREATMENTS: Treatment[] = [
  { code: "bio_stimulators", name: "ביו סטימולטורים", durationMinutes: 30, requiredRole: "doctor" },
  { code: "skin_booster", name: "סקין בוסטר", durationMinutes: 30, requiredRole: "doctor" },
  { code: "botox", name: "בוטוקס", durationMinutes: 30, requiredRole: "doctor" },
];

// Fillers from the website — provider not confirmed → left unassigned (no requiredRole).
const UNASSIGNED_TREATMENTS: Treatment[] = [
  { code: "lips_filler", name: "מילוי שפתיים", durationMinutes: 30 },
  { code: "nose_filler", name: "מילוי אף", durationMinutes: 30 },
  { code: "chin_filler", name: "מילוי סנטר", durationMinutes: 30 },
  { code: "jaw_filler", name: "מילוי קו לסת", durationMinutes: 30 },
  { code: "fox_eyes", name: "FOX EYES", durationMinutes: 30 },
  { code: "tear_trough", name: "מילוי שקעי עיניים", durationMinutes: 30 },
];

const CONSULTATION: Treatment = {
  code: "consultation",
  name: "ייעוץ",
  durationMinutes: 30,
  requiredRole: "consultation",
};

const TREATMENTS: Treatment[] = [
  CONSULTATION,
  ...NURSE_TREATMENTS,
  ...DOCTOR_TREATMENTS,
  ...UNASSIGNED_TREATMENTS,
];

const NURSE_CODES = NURSE_TREATMENTS.map((t) => t.code!);
const DOCTOR_CODES = DOCTOR_TREATMENTS.map((t) => t.code!);

/* ------------------------------- providers -------------------------------- */

const PROVIDERS: DoctorSite[] = [
  { doctorId: 1, doctorCode: "CONSULT_A", doctorName: "דנה", role: "consultation", treatments: ["consultation"], siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
  { doctorId: 2, doctorCode: "CONSULT_B", doctorName: "רות", role: "consultation", treatments: ["consultation"], siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
  { doctorId: 3, doctorCode: "NURSE_A", doctorName: "יעל", role: "nurse", treatments: NURSE_CODES, siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
  { doctorId: 4, doctorCode: "NURSE_B", doctorName: "תמר", role: "nurse", treatments: NURSE_CODES, siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
  { doctorId: 5, doctorCode: "NURSE_C", doctorName: "שירה", role: "nurse", treatments: NURSE_CODES, siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
  { doctorId: 6, doctorCode: "NURSE_D", doctorName: "אור", role: "nurse", treatments: NURSE_CODES, siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
  { doctorId: 7, doctorCode: "DOCTOR_A", doctorName: 'ד"ר דמו', role: "doctor", treatments: DOCTOR_CODES, siteId: 1, siteCode: "1", siteName: "מרפאה ראשית" },
];

/* ------------------------------ shift schedule ---------------------------- */
// day: 0=Sun … 6=Sat. Times "HH:MM". Availability is derived only from these rows,
// so editing this table is enough to reflect the real roster (no quotas anywhere).
// Tuesday(2) & Friday(5) are intentionally left as best-guess/empty pending confirmation.

interface Shift {
  providerId: number;
  day: number;
  start: string;
  end: string;
}

const SHIFTS: Shift[] = [
  // Nurses + injector doctor
  { providerId: 3, day: 0, start: "14:00", end: "19:00" }, // Sun — DemoC
  { providerId: 6, day: 1, start: "09:00", end: "19:00" }, // Mon — DemoF
  { providerId: 7, day: 1, start: "09:00", end: "19:00" }, // Mon — Doctor (hours assumed)
  { providerId: 5, day: 2, start: "09:00", end: "17:00" }, // Tue — DemoE
  { providerId: 4, day: 2, start: "09:00", end: "17:00" }, // Tue — DemoD
  { providerId: 3, day: 3, start: "14:00", end: "19:00" }, // Wed — DemoC
  { providerId: 4, day: 4, start: "09:00", end: "18:00" }, // Thu — DemoD
  { providerId: 7, day: 4, start: "09:00", end: "18:00" }, // Thu — Doctor
  // DemoE: twice a month on Thursdays — irregular, omitted from the simple weekly model.

  // Consultations (DemoA / DemoB)
  { providerId: 2, day: 0, start: "11:00", end: "19:00" }, // Sun — DemoB
  { providerId: 1, day: 1, start: "11:00", end: "19:00" }, // Mon — DemoA
  { providerId: 2, day: 1, start: "11:00", end: "17:00" }, // Mon — DemoB
  { providerId: 1, day: 2, start: "12:00", end: "17:00" }, // Tue — DemoA
  { providerId: 2, day: 3, start: "11:00", end: "19:00" }, // Wed — DemoB
  { providerId: 1, day: 3, start: "11:00", end: "17:00" }, // Wed — DemoA
  { providerId: 1, day: 4, start: "11:00", end: "17:00" }, // Thu — DemoA
  { providerId: 2, day: 4, start: "11:00", end: "17:00" }, // Thu — DemoB
];

export class MockProvider implements BookingProvider {
  private seq = 5000;
  private readonly providers = PROVIDERS.map(clone);
  private readonly treatments = TREATMENTS.map(clone);

  private patients: Patient[] = [
    { id: "1001", firstName: "מאיה", lastName: "כהן", fullName: "מאיה כהן", phone: "0501234567", idNumber: "032165498", email: "maya@example.com", gender: "female", birthDate: "1990-05-12" },
    { id: "1002", firstName: "דניאל", lastName: "לוי", fullName: "דניאל לוי", phone: "0529876543", idNumber: "045612378", gender: "male", birthDate: "1985-11-03" },
    { id: "1003", firstName: "נועה", lastName: "מזרחי", fullName: "נועה מזרחי", phone: "0541112233", gender: "female", birthDate: "1998-02-20" },
  ];

  // Seeded history/future appointments — carry type/treatmentCode/completed/activeSeries
  // so the gating layer can derive "consultation completed" and "active series".
  private appointments: Appointment[] = [
    // 1001 completed a botox consultation in the past → consultation_completed(botox)=true
    { id: "9001", patientId: "1001", patientName: "מאיה כהן", doctorCode: "CONSULT_A", providerId: 1, siteCode: "1", date: this.todayPlus(-30), startTime: "11:00:00", durationMinutes: 30, type: "consultation", treatmentCode: "botox", completed: true, subject: "ייעוץ בוטוקס" },
    // 1001 has an ACTIVE morpheus8 series (next session upcoming)
    { id: "9002", patientId: "1001", patientName: "מאיה כהן", doctorCode: "NURSE_A", providerId: 3, siteCode: "1", date: this.todayPlus(2), startTime: "15:00:00", durationMinutes: 60, type: "treatment", treatmentCode: "morpheus8", activeSeries: true, subject: "מורפאוס 8 - סדרה" },
    // 1003 completed a skin_booster consultation
    { id: "9003", patientId: "1003", patientName: "נועה מזרחי", doctorCode: "CONSULT_B", providerId: 2, siteCode: "1", date: this.todayPlus(-10), startTime: "12:00:00", durationMinutes: 30, type: "consultation", treatmentCode: "skin_booster", completed: true, subject: "ייעוץ סקין בוסטר" },
  ];

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, details: { provider: "mock" } };
  }

  /** Search — phone is the primary key (like Optima), name is a secondary match. */
  async searchPatient(query: string): Promise<Patient[]> {
    const q = query.trim().toLowerCase();
    if (!q) return this.patients.map(clone);
    const digits = q.replace(/\D/g, "");

    // Primary: phone match (when the query looks like a number).
    if (digits.length >= 3) {
      const byPhone = this.patients.filter((p) => (p.phone ?? "").replace(/\D/g, "").includes(digits));
      if (byPhone.length) return byPhone.map(clone);
    }
    // Secondary: name / id / email.
    return this.patients
      .filter((p) =>
        [p.fullName, p.firstName, p.lastName, p.idNumber, p.email]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q)),
      )
      .map(clone);
  }

  async getPatientAppointments(cardId: string): Promise<Appointment[]> {
    return this.appointments.filter((a) => a.patientId === cardId).map(clone);
  }

  async getAppointments(start: string, end: string): Promise<Appointment[]> {
    return this.appointments.filter((a) => a.date >= start && a.date <= end).map(clone);
  }

  async getAvailableSlots(req: AvailableSlotsRequest): Promise<Slot[]> {
    const treatment = req.treatmentCode
      ? this.treatments.find((t) => t.code === req.treatmentCode)
      : undefined;

    // A requested treatment with no assigned role (e.g. a filler) cannot be self-booked.
    if (req.treatmentCode && (!treatment || !treatment.requiredRole)) return [];

    const requiredRole: ProviderRole | undefined = treatment?.requiredRole;
    const duration = treatment?.durationMinutes ?? req.minDurationMinutes ?? 30;
    const buffer = treatment?.bufferMinutes ?? 0;
    const step = duration + buffer;

    let providers = this.providers;
    if (requiredRole) providers = providers.filter((p) => p.role === requiredRole);
    if (req.providerId != null) providers = providers.filter((p) => p.doctorId === req.providerId);
    if (req.doctorIds?.length) {
      providers = providers.filter((p) => p.doctorId != null && req.doctorIds!.includes(p.doctorId));
    }

    const slots: Slot[] = [];
    for (const date of datesBetween(req.start, req.end)) {
      const dow = new Date(`${date}T00:00:00`).getDay();
      for (const provider of providers) {
        const shifts = SHIFTS.filter((s) => s.providerId === provider.doctorId && s.day === dow);
        for (const shift of shifts) {
          const shiftStart = toMinutes(shift.start);
          const shiftEnd = toMinutes(shift.end);
          for (let m = shiftStart; m + duration <= shiftEnd; m += step) {
            const startTime = fromMinutes(m);
            if (this.isBooked(provider.doctorId, date, m, duration)) continue;
            slots.push({
              date,
              startTime,
              endTime: fromMinutes(m + duration),
              durationMinutes: duration,
              doctorId: provider.doctorId,
              doctorCode: provider.doctorCode,
              providerName: provider.doctorName,
              role: provider.role,
              treatmentCode: req.treatmentCode,
              siteId: provider.siteId,
            });
          }
        }
      }
    }
    return slots;
  }

  async getDoctorsSites(): Promise<DoctorSite[]> {
    return this.providers.map(clone);
  }

  async getHoursBlocking(): Promise<HoursBlock[]> {
    // No standing blocks in the mock beyond what the shift schedule already implies.
    return [];
  }

  /** Full treatment catalog when no patient is given; the patient's history otherwise. */
  async getTreatments(patientId: string): Promise<Treatment[]> {
    if (!patientId || patientId === "0") return this.treatments.map(clone);
    if (!this.patients.some((p) => p.id === patientId)) return [];
    return this.appointments
      .filter((a) => a.patientId === patientId && a.treatmentCode)
      .map((a) => {
        const cat = this.treatments.find((t) => t.code === a.treatmentCode);
        return clone<Treatment>({
          id: a.id,
          code: a.treatmentCode,
          name: cat?.name ?? a.treatmentCode,
          date: a.date,
          requiredRole: cat?.requiredRole,
        });
      });
  }

  async createAppointment(input: CreateAppointmentInput): Promise<WriteResult> {
    const id = String(++this.seq);
    const provider = this.providers.find((p) => p.doctorCode === input.doctorCode);
    const appointment: Appointment = {
      id,
      patientId: input.cardId && input.cardId !== "0" ? input.cardId : undefined,
      patientName: [input.firstName, input.lastName].filter(Boolean).join(" ") || undefined,
      doctorCode: input.doctorCode,
      providerId: provider?.doctorId,
      siteCode: input.siteCode ?? "1",
      date: input.date,
      startTime: normalizeTime(input.startTime),
      durationMinutes: input.durationMinutes,
      type: input.type,
      treatmentCode: input.treatmentCode,
      subject: input.subject,
      remarks: input.remarks,
    };
    this.appointments.push(appointment);
    return { ok: true, id, message: "נקבע בהצלחה", raw: clone(appointment) };
  }

  async modifyAppointment(input: ModifyAppointmentInput): Promise<WriteResult> {
    const appointment = this.appointments.find((a) => a.id === input.meetingId);
    if (!appointment) throw new BookingError(`Appointment "${input.meetingId}" not found.`);
    appointment.date = input.date;
    appointment.startTime = normalizeTime(input.startTime);
    appointment.durationMinutes = input.durationMinutes;
    if (input.subject !== undefined) appointment.subject = input.subject;
    if (input.doctorCode) appointment.doctorCode = input.doctorCode;
    if (input.remarks !== undefined) appointment.remarks = input.remarks;
    return { ok: true, id: appointment.id, message: "עודכן בהצלחה", raw: clone(appointment) };
  }

  async deleteAppointment(meetingId: string): Promise<WriteResult> {
    const idx = this.appointments.findIndex((a) => a.id === meetingId);
    if (idx === -1) throw new BookingError(`Appointment "${meetingId}" not found.`);
    const [removed] = this.appointments.splice(idx, 1);
    return { ok: true, id: meetingId, message: "בוטל בהצלחה", raw: clone(removed) };
  }

  async createContact(input: CreateContactInput): Promise<WriteResult> {
    const id = input.cardId && input.cardId !== "0" ? input.cardId : String(++this.seq);
    const patient: Patient = {
      id,
      firstName: input.firstName ?? "",
      lastName: input.lastName ?? "",
      fullName: [input.firstName, input.lastName].filter(Boolean).join(" "),
      phone: input.cellPhone,
      email: input.email,
    };
    this.patients.push(patient);
    return { ok: true, id, message: "נוצר בהצלחה", raw: clone(patient) };
  }

  async modifyContact(input: ModifyContactInput): Promise<WriteResult> {
    const patient = this.patients.find((p) => p.id === input.cardId);
    if (!patient) throw new BookingError(`Contact "${input.cardId}" not found.`);
    if (input.firstName !== undefined) patient.firstName = input.firstName;
    if (input.lastName !== undefined) patient.lastName = input.lastName;
    patient.fullName = [patient.firstName, patient.lastName].filter(Boolean).join(" ");
    if (input.cellPhone !== undefined) patient.phone = input.cellPhone;
    if (input.email !== undefined) patient.email = input.email;
    return { ok: true, id: patient.id, message: "עודכן בהצלחה", raw: clone(patient) };
  }

  async addLead(input: LeadInput): Promise<WriteResult> {
    const id = String(++this.seq);
    return { ok: true, id, message: "ליד נקלט", raw: { id, ...input } };
  }

  private isBooked(providerId: number | undefined, date: string, startMin: number, duration: number): boolean {
    const end = startMin + duration;
    return this.appointments.some((a) => {
      if (a.date !== date) return false;
      if (providerId != null && a.providerId != null) {
        if (a.providerId !== providerId) return false;
      }
      const aStart = toMinutes(a.startTime.slice(0, 5));
      const aEnd = aStart + (a.durationMinutes ?? 30);
      return startMin < aEnd && aStart < end; // overlap
    });
  }

  private todayPlus(days: number): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return toIso(d);
  }
}

function datesBetween(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const start = new Date(`${startIso}T00:00:00`);
  const end = new Date(`${endIso}T00:00:00`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) out.push(toIso(d));
  return out;
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function fromMinutes(total: number): string {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}:00`;
}

function normalizeTime(time: string): string {
  const [h, m, s = "00"] = time.trim().split(":");
  return `${pad(Number(h))}:${pad(Number(m))}:${pad(Number(s))}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
