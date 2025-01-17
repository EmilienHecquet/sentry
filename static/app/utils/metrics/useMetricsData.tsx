import {useCallback, useEffect, useState} from 'react';

import type {DateString, PageFilters} from 'sentry/types';
import {getDateTimeParams, getDDMInterval} from 'sentry/utils/metrics';
import {getUseCaseFromMRI, parseField} from 'sentry/utils/metrics/mri';
import type {MetricsQuery} from 'sentry/utils/metrics/types';
import {useApiQuery} from 'sentry/utils/queryClient';
import useOrganization from 'sentry/utils/useOrganization';

import type {
  MetricsApiRequestQueryOptions,
  MetricsQueryApiResponse,
} from '../../types/metrics';

export function createMqlQuery({
  field,
  query,
  groupBy = [],
}: {field: string; groupBy?: string[]; query?: string}) {
  let mql = field;
  if (query) {
    mql = `${mql}{${query}}`;
  }
  if (groupBy.length) {
    mql = `${mql} by (${groupBy.join(',')})`;
  }
  return mql;
}

function getMetricsQueryApiRequestPayload(
  {
    field,
    query,
    groupBy,
    orderBy,
  }: {field: string; query: string; groupBy?: string[]; orderBy?: 'asc' | 'desc'},
  {projects, environments, datetime}: PageFilters,
  {intervalLadder, ...overrides}: Partial<MetricsApiRequestQueryOptions> = {}
) {
  const {mri: mri} = parseField(field) ?? {};
  const useCase = getUseCaseFromMRI(mri) ?? 'custom';
  const interval = getDDMInterval(datetime, useCase, intervalLadder);

  return {
    query: {
      ...getDateTimeParams(datetime),
      project: projects,
      environment: environments,
      interval,
      ...overrides,
    },
    body: {
      queries: [
        {
          name: 'query_1',
          mql: createMqlQuery({field, query, groupBy}),
        },
      ],
      formulas: [{mql: '$query_1', limit: overrides.limit, order: orderBy ?? 'desc'}],
    },
  };
}

export function useMetricsQuery(
  {mri, op, datetime, projects, environments, query, groupBy}: MetricsQuery,
  overrides: Partial<MetricsApiRequestQueryOptions> = {}
) {
  const organization = useOrganization();

  const field = op ? `${op}(${mri})` : mri;

  const {query: queryToSend, body} = getMetricsQueryApiRequestPayload(
    {
      field,
      query: query ?? '',
      groupBy,
    },
    {datetime, projects, environments},
    {...overrides}
  );

  return useApiQuery<MetricsQueryApiResponse>(
    [
      `/organizations/${organization.slug}/metrics/query/`,
      {query: queryToSend, data: body, method: 'POST'},
    ],
    {
      retry: 0,
      staleTime: 0,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
      refetchInterval: false,
    }
  );
}

// Wraps useMetricsData and provides two additional features:
// 1. return data is undefined only during the initial load
// 2. provides a callback to trim the data to a specific time range when chart zoom is used
export function useMetricsQueryZoom(
  metricsQuery: MetricsQuery,
  overrides: Partial<MetricsApiRequestQueryOptions> = {}
) {
  const [metricsData, setMetricsData] = useState<MetricsQueryApiResponse | undefined>();
  const {
    data: rawData,
    isLoading,
    isError,
    error,
  } = useMetricsQuery(metricsQuery, overrides);

  useEffect(() => {
    if (rawData) {
      setMetricsData(rawData);
    }
  }, [rawData]);

  const trimData = useCallback(
    (
      currentData: MetricsQueryApiResponse | undefined,
      start,
      end
    ): MetricsQueryApiResponse | undefined => {
      if (!currentData) {
        return currentData;
      }
      // find the index of the first interval that is greater than the start time
      const startIndex =
        currentData.intervals.findIndex(interval => interval >= start) - 1;
      const endIndex = currentData.intervals.findIndex(interval => interval >= end);

      if (startIndex === -1 || endIndex === -1) {
        return currentData;
      }

      return {
        ...currentData,
        intervals: currentData.intervals.slice(startIndex, endIndex),
        data: currentData.data.map(group =>
          group.map(entry => ({
            ...entry,
            series: entry.series.slice(startIndex, endIndex),
          }))
        ),
      };
    },
    []
  );

  const handleZoom = useCallback(
    (start: DateString, end: DateString) => {
      setMetricsData(currentData => trimData(currentData, start, end));
    },
    [trimData]
  );

  return {
    data: metricsData,
    isLoading,
    isError,
    error,
    onZoom: handleZoom,
  };
}
