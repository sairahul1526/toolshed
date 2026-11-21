import type { Messages } from './types';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const minutes = (n: number) => plural(n, 'minuto', 'minutos');
const hours = (n: number) => plural(n, 'hora', 'horas');
const days = (n: number) => plural(n, 'día', 'días');

export const es: Messages = {
  common: {
    sentBy: (brand) => `Enviado por ${brand}.`,
    ignore: 'Si no esperabas este correo, puedes ignorarlo.',
    linkFallback: 'Si el botón no funciona, copia este enlace en tu navegador:',
  },
  'sign-in-code': (d, b) => ({
    subject: `Tu código para entrar a ${b.name}`,
    preheader: `Usa el código para entrar. Vale durante ${minutes(d.minutes)}.`,
    heading: `Entra a ${b.name}`,
    paragraphs: [`Escribe este código en la página de acceso. Vale durante ${minutes(d.minutes)} y solo una vez.`],
    code: d.code,
    buttonIntro: 'O abre este enlace en este dispositivo para entrar sin escribir el código:',
    button: { label: `Entrar a ${b.name}`, href: d.link },
    small: ['Si no pediste entrar, ignora este correo. Nadie puede entrar sin el código o el enlace.'],
  }),
  'claim-code': (d, b) => ({
    subject: `Termina de configurar ${b.name}`,
    preheader: `Tu código de configuración vale durante ${minutes(d.minutes)}.`,
    heading: `Termina de configurar ${b.name}`,
    paragraphs: [`Escribe este código para ser el propietario de esta instalación. Vale durante ${minutes(d.minutes)}.`],
    code: d.code,
    small: ['Si no iniciaste esta configuración, ignora este correo y no cambiará nada.'],
  }),
  invite: (d, b) => ({
    subject: `${d.inviterName} te invitó a ${d.workspaceName}`,
    preheader: `Únete a ${d.workspaceName} en ${b.name} como ${d.role}.`,
    heading: `Únete a ${d.workspaceName}`,
    paragraphs: [
      `${d.inviterName} te invitó a ${d.workspaceName} en ${b.name}. Entrarás como ${d.role}.`,
      `La invitación vale durante ${days(d.days)}.`,
    ],
    button: { label: 'Aceptar la invitación', href: d.link },
    small: ['Si no conoces a esta persona, puedes ignorar este correo.'],
  }),
  'email-change': (d, b) => ({
    subject: `Confirma tu nuevo correo en ${b.name}`,
    preheader: `Tu código de confirmación vale durante ${minutes(d.minutes)}.`,
    heading: 'Confirma tu nuevo correo',
    paragraphs: [`Escribe este código para usar esta dirección en ${b.name}. Vale durante ${minutes(d.minutes)}.`],
    code: d.code,
    small: ['Si no pediste este cambio, ignora este correo. Tu cuenta sigue igual.'],
  }),
  'new-device': (d, b) => ({
    subject: `Nuevo acceso a ${b.name}`,
    preheader: `${d.device} entró a tu cuenta.`,
    heading: 'Nuevo acceso a tu cuenta',
    paragraphs: ['Vimos un acceso desde un dispositivo que no conocíamos.', `Dispositivo: ${d.device}`, `Dirección IP: ${d.ip}`, `Hora: ${d.time}`],
    small: ['Si fuiste tú, no tienes que hacer nada. Si no, entra, abre Cuenta y cierra todas las sesiones.'],
  }),
  test: (_d, b) => ({
    subject: `Correo de prueba de ${b.name}`,
    preheader: 'El envío de correo funciona.',
    heading: 'El envío de correo funciona',
    paragraphs: [`Este es un correo de prueba de ${b.name}. Si puedes leerlo, los códigos y las invitaciones también llegarán.`],
  }),
  'export-ready': (d) => ({
    subject: 'Tu exportación está lista',
    preheader: `La descarga vale durante ${hours(d.hours)}.`,
    heading: 'Tu exportación está lista',
    paragraphs: [`Todo lo de tu espacio de trabajo está en un archivo. El enlace vale durante ${hours(d.hours)} y solo los administradores pueden abrirlo.`],
    button: { label: 'Descargar la exportación', href: d.link },
  }),
  notification: (d) => ({
    subject: d.title,
    preheader: d.body,
    heading: d.title,
    paragraphs: d.body ? d.body.split(/\n{2,}/) : [],
    ...(d.link ? { button: { label: d.linkLabel ?? 'Abrir', href: d.link } } : {}),
  }),
};
