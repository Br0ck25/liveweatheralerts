export interface AlertRecord {
  id: string;
  stateCode: string;
  ugc?: string[];
  event: string;
  areaDesc: string;
  severity: string;
  status: string;
  urgency: string;
  certainty: string;
  headline: string;
  description: string;
  instruction: string;
  sent: string;
  effective: string;
  onset: string;
  expires: string;
  updated: string;
  nwsUrl: string;
}

export interface AlertsPayload {
  alerts: AlertRecord[];
  lastPoll: string | null;
  syncError: string | null;
}
