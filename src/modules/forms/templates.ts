/** The starting points offered on first run and in "New form". Each builds a fresh, valid definition. */
import { emptyDefinition, parseDefinition, type Definition, type Field, type FieldType, type FormSettings } from './schema';

export interface Template {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** Suggested name for a new form made from it. */
  formName: string;
  build(): Definition;
  settings?: Partial<FormSettings>;
}

type Extra = Partial<Omit<Field, 'id' | 'type' | 'label' | 'key'>>;

function q(id: string, type: FieldType, label: string, extra: Extra = {}): Field {
  return { id, type, label, key: id.replace(/^q_/, ''), required: false, ...extra };
}

const choice = (labels: string[], points?: number[]) => labels.map((label, i) => ({ id: `o${i + 1}`, label, ...(points ? { points: points[i]! } : {}) }));

function def(fields: Field[], ending: { title: string; body: string }, extra: Partial<Definition> = {}): Definition {
  const base = emptyDefinition();
  return parseDefinition({
    ...base,
    pages: [{ id: 'p1', fields }],
    endings: [{ id: 'e1', title: ending.title, body: ending.body, passAnswers: false }],
    ...extra,
  });
}

export const TEMPLATES: Template[] = [
  {
    id: 'contact',
    name: 'Contact',
    description: 'Name, email and a message. The classic.',
    icon: 'mail',
    formName: 'Contact us',
    build: () =>
      def(
        [
          q('q_name', 'short_text', 'Your name', { required: true }),
          q('q_email', 'email', 'Email address', { required: true, placeholder: 'name@example.com' }),
          q('q_message', 'long_text', 'How can we help?', { required: true }),
        ],
        { title: 'Thanks, {{name}}', body: 'We got your message and will reply by email.' },
      ),
    settings: { notify: { enabled: true, emails: [] }, autoresponder: { enabled: true, fieldId: 'q_email', subject: 'We got your message', body: 'Thanks for getting in touch. We read every message and will reply soon.' } },
  },
  {
    id: 'feedback-nps',
    name: 'Feedback with NPS',
    description: 'A 0 to 10 score, a reason, and an optional follow-up.',
    icon: 'chart',
    formName: 'Customer feedback',
    build: () =>
      def(
        [
          q('q_nps', 'nps', 'How likely are you to recommend us to a friend or colleague?', { required: true, min: 0, max: 10, minLabel: 'Not likely', maxLabel: 'Very likely' }),
          q('q_reason', 'long_text', 'What is the main reason for your score?'),
          q('q_better', 'long_text', 'What one thing would make us better?', { showIf: { mode: 'all', rules: [{ field: 'q_nps', op: 'lte', value: 6 }] } }),
          q('q_email', 'email', 'Email, if you would like a reply'),
        ],
        { title: 'Thank you', body: 'Your feedback goes straight to the team.' },
      ),
  },
  {
    id: 'csat-support',
    name: 'CSAT after support',
    description: 'One question to rate a support conversation, with a follow-up.',
    icon: 'star',
    formName: 'Support satisfaction',
    build: () =>
      def(
        [
          q('q_csat', 'csat', 'How satisfied were you with the help you got?', { required: true, min: 1, max: 5, minLabel: 'Very unsatisfied', maxLabel: 'Very satisfied' }),
          q('q_ces', 'ces', 'How easy was it to get your problem solved?', { min: 1, max: 7, minLabel: 'Very difficult', maxLabel: 'Very easy' }),
          q('q_what', 'long_text', 'Tell us what we could have done better', { showIf: { mode: 'all', rules: [{ field: 'q_csat', op: 'lte', value: 3 }] } }),
          q('q_ticket', 'hidden', 'Ticket', { param: 'ticket' }),
        ],
        { title: 'Thanks for rating', body: 'We use every response to improve our support.' },
      ),
  },
  {
    id: 'event',
    name: 'Event registration',
    description: 'Name, email, ticket choice and dietary needs, with a cap on places.',
    icon: 'cal',
    formName: 'Event registration',
    build: () =>
      def(
        [
          q('q_name', 'short_text', 'Full name', { required: true }),
          q('q_email', 'email', 'Email address', { required: true }),
          q('q_ticket', 'single_choice', 'Ticket', { required: true, options: choice(['General admission', 'Student', 'Speaker']) }),
          q('q_diet', 'multiple_choice', 'Dietary needs', { options: choice(['Vegetarian', 'Vegan', 'Gluten free', 'Nut allergy']) }),
          q('q_consent', 'consent', 'I agree to be contacted about this event', { required: true }),
        ],
        { title: 'You are registered', body: 'A confirmation is on its way to {{email}}.' },
      ),
    settings: { cap: 100, closedMessage: 'Registration is closed.', autoresponder: { enabled: true, fieldId: 'q_email', subject: 'You are registered', body: 'You are on the list. We will send details closer to the day.' } },
  },
  {
    id: 'waitlist',
    name: 'Waitlist',
    description: 'Collect emails before launch. Just an email and one optional question.',
    icon: 'clock',
    formName: 'Join the waitlist',
    build: () =>
      def(
        [
          q('q_email', 'email', 'Email address', { required: true, placeholder: 'name@example.com' }),
          q('q_use', 'short_text', 'What would you use it for?'),
        ],
        { title: 'You are on the list', body: 'We will email you when there is room.' },
      ),
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'Start from nothing and add your own questions.',
    icon: 'plus',
    formName: 'Untitled form',
    build: () => emptyDefinition(),
  },
];

export function template(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
