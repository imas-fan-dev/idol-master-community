-- ims:migration-phase: post-data

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT series_code FROM public.fudaba_office_series_tags
            UNION ALL
            SELECT series_code FROM public.fudaba_cards
        ) referenced_series
        WHERE referenced_series.series_code = 'valiv'
    ) THEN
        RAISE EXCEPTION
            'FUDABA_VALIV_AGENCY_RECONCILIATION_REQUIRED: valiv is not 876PRO and cannot be mapped automatically';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            SELECT series_code FROM public.fudaba_office_series_tags
            UNION ALL
            SELECT series_code FROM public.fudaba_cards
        ) referenced_series
        WHERE referenced_series.series_code NOT IN (
            '765as', 'cinderella', 'million-live', 'sidem',
            'shiny-colors', 'gakuen'
        )
    ) THEN
        RAISE EXCEPTION
            'FUDABA_UNKNOWN_SERIES_RECONCILIATION_REQUIRED: an associated series has no canonical agency mapping';
    END IF;

    IF EXISTS (
        WITH mapping(source_code, agency_code) AS (VALUES
            ('765as', '765'),
            ('cinderella', 'cg'),
            ('million-live', 'ml'),
            ('sidem', 'sidem'),
            ('shiny-colors', 'sc'),
            ('gakuen', 'gk')
        ), referenced_series AS (
            SELECT series_code FROM public.fudaba_office_series_tags
            UNION
            SELECT series_code FROM public.fudaba_cards
        )
        SELECT 1
        FROM referenced_series referenced
        JOIN mapping ON mapping.source_code = referenced.series_code
        LEFT JOIN public.agencies agency ON agency.code = mapping.agency_code
        WHERE agency.id IS NULL
    ) THEN
        RAISE EXCEPTION
            'FUDABA_CANONICAL_AGENCY_MISSING: seed or import the referenced agency catalog before this migration';
    END IF;
END;
$$;

ALTER TABLE public.fudaba_office_series_tags
    DROP CONSTRAINT fudaba_office_series_tags_series_code_fkey;
ALTER TABLE public.fudaba_cards
    DROP CONSTRAINT fudaba_cards_series_code_fkey;

UPDATE public.fudaba_office_series_tags
SET series_code = CASE series_code
    WHEN '765as' THEN '765'
    WHEN 'cinderella' THEN 'cg'
    WHEN 'million-live' THEN 'ml'
    WHEN 'sidem' THEN 'sidem'
    WHEN 'shiny-colors' THEN 'sc'
    WHEN 'gakuen' THEN 'gk'
END;

UPDATE public.fudaba_cards
SET series_code = CASE series_code
    WHEN '765as' THEN '765'
    WHEN 'cinderella' THEN 'cg'
    WHEN 'million-live' THEN 'ml'
    WHEN 'sidem' THEN 'sidem'
    WHEN 'shiny-colors' THEN 'sc'
    WHEN 'gakuen' THEN 'gk'
END;

ALTER TABLE public.fudaba_office_series_tags
    ADD CONSTRAINT fudaba_office_series_tags_series_code_fkey
    FOREIGN KEY (series_code) REFERENCES public.agencies(code) ON DELETE RESTRICT;
ALTER TABLE public.fudaba_cards
    ADD CONSTRAINT fudaba_cards_series_code_fkey
    FOREIGN KEY (series_code) REFERENCES public.agencies(code) ON DELETE RESTRICT;

DROP TABLE public.fudaba_series_tags;
