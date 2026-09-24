import { configure } from "@testing-library/dom";
import "@testing-library/jest-dom/vitest";

// CI runners are slower than local machines: the default 1s async timeout
// causes flaky `findBy*` failures under load. Raise it globally.
configure({ asyncUtilTimeout: 4000 });