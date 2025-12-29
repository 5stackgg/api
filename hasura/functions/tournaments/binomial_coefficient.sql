CREATE OR REPLACE FUNCTION public.binomial_coefficient(n int, k int)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    result numeric;
    i int;
BEGIN
    -- Validate inputs
    IF n < 0 OR k < 0 OR k > n THEN
        RETURN 0;
    END IF;
    
    -- C(n, 0) = C(n, n) = 1
    IF k = 0 OR k = n THEN
        RETURN 1;
    END IF;
    
    -- Use symmetry: C(n, k) = C(n, n-k)
    -- Choose the smaller k for efficiency
    IF k > n - k THEN
        k := n - k;
    END IF;
    
    -- Calculate iteratively: C(n, k) = (n * (n-1) * ... * (n-k+1)) / (k * (k-1) * ... * 1)
    result := 1;
    FOR i IN 1..k LOOP
        result := result * (n - k + i) / i;
    END LOOP;
    
    RETURN result;
END;
$$;

