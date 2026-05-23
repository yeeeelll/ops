export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertResult {
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  message: string;
}

export interface Check {
  name: string;
  run(): Promise<AlertResult[]>;
}
