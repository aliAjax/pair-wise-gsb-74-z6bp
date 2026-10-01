import type {
  ContractDifference,
  DownstreamDependency,
  EventDefinition,
  EventProperty,
  FrozenDependencyRef,
  FrozenEventContract,
  GovernanceState,
  PlatformRule,
  ReleaseCandidate,
  ReleaseSnapshot,
} from '@/models/domain'

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export const hashLineage = (value: unknown): string => {
  const input = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const propertySignature = (property: EventProperty): Record<string, unknown> => ({
  id: property.id,
  name: property.name,
  type: property.type,
  required: property.required,
  enumValues: [...property.enumValues].sort(),
  deletedAt: property.deletedAt ?? null,
  lineageSourceId: property.lineageSourceId ?? null,
})

const platformRuleSignature = (rule: PlatformRule): Record<string, unknown> => ({
  platform: rule.platform,
  enabled: rule.enabled,
  trigger: rule.trigger,
  requiredPropertyIds: [...rule.requiredPropertyIds].sort(),
})

const findProperty = (
  events: EventDefinition[],
  propertyId: string,
): EventProperty | undefined => {
  for (const event of events) {
    const property = event.properties.find((item) => item.id === propertyId)
    if (property) return property
  }
  return undefined
}

export const computeEventDigest = (
  events: EventDefinition[],
  event: EventDefinition,
): string =>
  hashLineage({
    key: event.key,
    version: event.version,
    trigger: event.trigger,
    properties: event.properties.map(propertySignature),
    platformRules: event.platformRules.map(platformRuleSignature),
    lineageSources: event.properties
      .filter((property) => property.lineageSourceId)
      .map((property) => {
        const source = findProperty(events, property.lineageSourceId!)
        return {
          propertyId: property.id,
          sourceId: property.lineageSourceId,
          source: source ? propertySignature(source) : null,
        }
      }),
  })

export const computeDependencyDigest = (
  events: EventDefinition[],
  dependency: DownstreamDependency,
): string =>
  hashLineage({
    eventIds: [...dependency.eventIds].sort(),
    propertyRefs: dependency.propertyRefs.map((reference) => {
      const event = events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      return {
        eventId: reference.eventId,
        propertyId: reference.propertyId,
        property: property ? propertySignature(property) : null,
      }
    }),
  })

export const freezeReleaseSnapshot = (
  events: EventDefinition[],
  dependencies: DownstreamDependency[],
  eventIds: string[],
  affectedDependencyIds: string[],
): ReleaseSnapshot => {
  const frozenEvents: FrozenEventContract[] = eventIds
    .map((eventId) => events.find((event) => event.id === eventId))
    .filter((event): event is EventDefinition => Boolean(event))
    .map((event) => ({
      eventId: event.id,
      key: event.key,
      displayName: event.displayName,
      version: event.version,
      trigger: event.trigger,
      owner: event.owner,
      properties: structuredClone(event.properties),
      platformRules: structuredClone(event.platformRules),
      digest: computeEventDigest(events, event),
    }))
  const frozenDependencies: FrozenDependencyRef[] = affectedDependencyIds
    .map((dependencyId) => dependencies.find((dependency) => dependency.id === dependencyId))
    .filter((dependency): dependency is DownstreamDependency => Boolean(dependency))
    .map((dependency) => ({
      dependencyId: dependency.id,
      name: dependency.name,
      owner: dependency.owner,
      digest: computeDependencyDigest(events, dependency),
    }))
  return {
    frozenAt: new Date().toISOString(),
    overallDigest: hashLineage({
      events: frozenEvents.map((event) => event.digest),
      dependencies: frozenDependencies.map((dependency) => dependency.digest),
    }),
    events: frozenEvents,
    dependencies: frozenDependencies,
  }
}

export interface ReleaseDrift {
  eventDrifts: Array<{ eventId: string; eventKey: string }>
  dependencyDrifts: Array<{ dependencyId: string; name: string }>
}

export const emptyDrift = (drift: ReleaseDrift): boolean =>
  drift.eventDrifts.length === 0 && drift.dependencyDrifts.length === 0

export const detectReleaseDrift = (
  state: Pick<GovernanceState, 'events' | 'dependencies'>,
  release: ReleaseCandidate,
): ReleaseDrift => {
  const eventDrifts: ReleaseDrift['eventDrifts'] = []
  const dependencyDrifts: ReleaseDrift['dependencyDrifts'] = []

  release.snapshot.events.forEach((frozen) => {
    const live = state.events.find((event) => event.id === frozen.eventId)
    if (!live || computeEventDigest(state.events, live) !== frozen.digest) {
      eventDrifts.push({ eventId: frozen.eventId, eventKey: frozen.key })
    }
  })

  release.snapshot.dependencies.forEach((frozen) => {
    const live = state.dependencies.find((dependency) => dependency.id === frozen.dependencyId)
    if (!live || computeDependencyDigest(state.events, live) !== frozen.digest) {
      dependencyDrifts.push({ dependencyId: frozen.dependencyId, name: frozen.name })
    }
  })

  return { eventDrifts, dependencyDrifts }
}

export const differenceFromFrozen = (
  frozen: FrozenEventContract,
  difference: ContractDifference | undefined,
): ContractDifference =>
  difference ?? {
    eventId: frozen.eventId,
    eventKey: frozen.key,
    addedProperties: [],
    removedProperties: [],
    requiredChanges: [],
    typeChanges: [],
    enumChanges: [],
  }
