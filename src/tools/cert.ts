import tls from 'node:tls';
import type { DetailedPeerCertificate } from 'node:tls';
import { registerTool } from './registry.js';
import type { ToolResult } from '../agent/types.js';

function flattenCn(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(', ');
  return v ?? '';
}

interface CertInfo {
  subject_cn: string;
  subject_alt_names: string[];
  issuer_cn: string;
  issuer_o: string;
  valid_from: string;
  valid_to: string;
  days_left: number;
  fingerprint_sha256: string;
  serial: string;
  chain_length: number;
  self_signed: boolean;
  authorized: boolean;
  authorization_error: string | null;
}

function probeCert(host: string, port: number, servername: string, timeoutMs: number): Promise<CertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername,
        rejectUnauthorized: false,
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true) as DetailedPeerCertificate;
          if (!cert || Object.keys(cert).length === 0) {
            socket.end();
            reject(new Error('peer returned no certificate'));
            return;
          }
          const validTo = new Date(cert.valid_to);
          const daysLeft = Number.isNaN(validTo.getTime())
            ? -1
            : Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
          const subjectAlt =
            typeof cert.subjectaltname === 'string'
              ? cert.subjectaltname
                  .split(',')
                  .map((s) => s.trim().replace(/^DNS:/, ''))
                  .filter(Boolean)
              : [];
          let chainLength = 1;
          let walker: DetailedPeerCertificate | undefined = cert.issuerCertificate;
          const seen = new Set<string>();
          while (walker && walker !== cert && !seen.has(walker.fingerprint256 ?? '')) {
            seen.add(walker.fingerprint256 ?? '');
            chainLength += 1;
            if (!walker.issuerCertificate || walker.issuerCertificate === walker) break;
            walker = walker.issuerCertificate;
          }
          const subjectCn = flattenCn(cert.subject?.CN);
          const issuerCn = flattenCn(cert.issuer?.CN);
          const info: CertInfo = {
            subject_cn: subjectCn,
            subject_alt_names: subjectAlt,
            issuer_cn: issuerCn,
            issuer_o: flattenCn(cert.issuer?.O),
            valid_from: cert.valid_from ?? '',
            valid_to: cert.valid_to ?? '',
            days_left: daysLeft,
            fingerprint_sha256: cert.fingerprint256 ?? '',
            serial: cert.serialNumber ?? '',
            chain_length: chainLength,
            self_signed: subjectCn === issuerCn && chainLength === 1,
            authorized: socket.authorized,
            authorization_error: socket.authorizationError
              ? String(socket.authorizationError)
              : null,
          };
          socket.end();
          resolve(info);
        } catch (err) {
          socket.destroy();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`TLS handshake timeout after ${timeoutMs}ms`));
    });
    socket.on('error', reject);
  });
}

registerTool({
  name: 'cert_check',
  description:
    '查询任意主机 TLS 证书有效期 + issuer + SAN. host 必填 (域名或 IP), port 默认 443. 不限于宝塔站点. 只读.',
  parameters: {
    type: 'object',
    properties: {
      host: { type: 'string', description: '目标主机 (域名或 IP)' },
      port: { type: 'integer', description: 'TLS 端口, 默认 443' },
      servername: { type: 'string', description: 'SNI 主机名, 默认 = host' },
      timeout_ms: { type: 'integer', description: '握手超时, 默认 10000, 最大 30000' },
    },
    required: ['host'],
    additionalProperties: false,
  },
  async handler(args): Promise<ToolResult> {
    const host = String(args.host ?? '').trim();
    if (!host) return { ok: false, content: 'host required' };
    const port = Math.min(65_535, Math.max(1, Number(args.port) || 443));
    const servername = typeof args.servername === 'string' && args.servername ? args.servername : host;
    const timeoutMs = Math.min(30_000, Math.max(1_000, Number(args.timeout_ms) || 10_000));
    try {
      const info = await probeCert(host, port, servername, timeoutMs);
      const lines: string[] = [
        `# ${host}:${port} (SNI: ${servername})`,
        `主体 CN:       ${info.subject_cn || '-'}`,
        `SAN:           ${info.subject_alt_names.join(', ') || '-'}`,
        `颁发者:        ${info.issuer_cn || '-'} (O: ${info.issuer_o || '-'})`,
        `有效期起:      ${info.valid_from || '-'}`,
        `有效期止:      ${info.valid_to || '-'}`,
        `剩余天数:      ${info.days_left}`,
        `链长度:        ${info.chain_length}`,
        `自签:          ${info.self_signed ? '是' : '否'}`,
        `校验通过:      ${info.authorized ? '是' : `否 (${info.authorization_error ?? 'n/a'})`}`,
        `SHA256:        ${info.fingerprint_sha256 || '-'}`,
        `序列号:        ${info.serial || '-'}`,
      ];
      return { ok: true, content: lines.join('\n') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `cert_check failed: ${msg}` };
    }
  },
});
