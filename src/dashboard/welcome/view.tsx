/** The page at /app/welcome: what to start with, what is left to set up, and facts about this install. */
import { progressLine, type SetupProgress, type SetupStep } from '../../core/onboarding';
import { Button, Callout, Card, Icon, KeyValueList, LinkButton, PageHeader, Pill, formatBytes } from '../../ui';
import { BASE, type InstallFacts, type StartCard, type WelcomeData } from './data';

function StartCards({ cards, moduleCount }: { cards: StartCard[]; moduleCount: number }) {
  return (
    <form method="post" action={`${BASE}/start`} class="choices" aria-label="Start a module">
      {cards.map((card) =>
        card.on ? (
          <a class="choice" href={card.href}>
            <span class="choice-top">
              <span class="tile">
                <Icon name={card.icon} />
              </span>
              <Pill tone="good">On</Pill>
            </span>
            <b>{card.title}</b>
            <span>{card.body}</span>
          </a>
        ) : (
          <button type="submit" class="choice" name="module" value={card.id}>
            <span class="tile">
              <Icon name={card.icon} />
            </span>
            <b>{card.title}</b>
            <span>{card.body}</span>
          </button>
        ),
      )}
      <a class="choice" href="/app/modules">
        <span class="tile quiet">
          <Icon name="grid" />
        </span>
        <b>{moduleCount === 1 ? 'See the module' : `See all ${moduleCount} modules`}</b>
        <span>Switch on what you need. Nothing costs extra.</span>
      </a>
    </form>
  );
}

function StepRow({ step }: { step: SetupStep }) {
  return (
    <li class={step.done ? 'done' : undefined}>
      <span class="tick">{step.done ? <Icon name="check" label="Done" /> : null}</span>
      <span class="row-text">
        <b>{step.title}</b>
        <span>{step.body}</span>
      </span>
      {step.done ? null : (
        <LinkButton size="sm" href={step.href} aria-label={`${step.action}: ${step.title}`}>
          {step.action}
        </LinkButton>
      )}
    </li>
  );
}

/** Shown in place of the steps when they could not be read. */
function StepsUnavailable() {
  return (
    <Card title="Finish setting up">
      <Callout tone="warn" title="We couldn’t load the setup steps" actions={<LinkButton size="sm" href={BASE}>Reload</LinkButton>}>
        Nothing is lost. Everything else on this page still works.
      </Callout>
    </Card>
  );
}

function Steps({ progress }: { progress: SetupProgress }) {
  const finished = progress.done >= progress.total;
  return (
    <Card
      title="Finish setting up"
      description={progressLine(progress)}
      ruled
      flush
      actions={<span class="mono muted">{progress.percent}%</span>}
      footer={
        <form method="post" action={`${BASE}/sidebar`} class="foot-line">
          <span class="note">
            {progress.hidden ? 'Get started is hidden from the sidebar.' : finished ? 'Get started has left the sidebar. This page stays at this address.' : 'Done here? You can take Get started out of the sidebar.'}
          </span>
          {progress.hidden ? (
            <Button size="sm" variant="ghost" type="submit" name="hidden" value="0">
              Show in sidebar
            </Button>
          ) : finished ? null : (
            <Button size="sm" variant="ghost" type="submit" name="hidden" value="1">
              Hide from sidebar
            </Button>
          )}
        </form>
      }
    >
      <div class="progress-wrap">
        <div class="progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
          <i style={`width:${progress.percent}%`}></i>
        </div>
      </div>
      <ul class="rows">
        {progress.steps.map((step) => (
          <StepRow step={step} />
        ))}
      </ul>
    </Card>
  );
}

function SampleCard({ sample }: { sample: WelcomeData['sample'] }) {
  const showing = sample.showing.length > 0 ? `Showing now in ${new Intl.ListFormat('en', { type: 'conjunction' }).format(sample.showing)}.` : null;
  return (
    <Card
      title="Sample data"
      description={
        <>
          Modules you start here come with example rows so you can look around. Turn this off to remove them. Your own data is never touched.
          {showing ? <span class="sample-now"> {showing}</span> : null}
        </>
      }
      actions={
        <form method="post" action={`${BASE}/sample`}>
          <button type="submit" class="switch switch-lg" role="switch" aria-checked={sample.on ? 'true' : 'false'} aria-label="Sample data" name="sample" value={sample.on ? '0' : '1'}></button>
        </form>
      }
    />
  );
}

function InstallCard({ install, owner }: { install: InstallFacts; owner: boolean }) {
  const items = [
    { label: 'Version', value: `v${install.version}` },
    { label: 'Address', value: <span class="mono">{install.address}</span> },
    { label: 'Runs on', value: 'Your Cloudflare account' },
    ...(install.databaseBytes === null ? [] : [{ label: 'Database', value: formatBytes(install.databaseBytes) }]),
  ];
  return (
    <Card
      title="This install"
      actions={
        owner ? (
          <a class="select-btn" href="/app/updates">
            Updates
            <Icon name="out" />
          </a>
        ) : null
      }
    >
      <KeyValueList items={items} />
    </Card>
  );
}

export function WelcomeView({ data }: { data: WelcomeData }) {
  return (
    <>
      <PageHeader
        title="Welcome to Toolshed."
        soft="What first?"
        description="Your workspace is ready. Start a module, or finish setting up below."
        actions={
          <LinkButton variant="primary" icon="plus" href="/app/members#invite">
            Invite people
          </LinkButton>
        }
      />
      <StartCards cards={data.cards} moduleCount={data.moduleCount} />
      <div class="split welcome-split">
        {data.progress ? <Steps progress={data.progress} /> : <StepsUnavailable />}
        <div class="stack">
          <SampleCard sample={data.sample} />
          <InstallCard install={data.install} owner={data.shell.user.isInstanceOwner} />
        </div>
      </div>
    </>
  );
}
