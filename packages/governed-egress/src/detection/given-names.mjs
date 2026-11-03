/**
 * Common given names, used to find a person's name that carries no label
 * ("Spoke with Jane Doe", a headerless list of names). 0.3.0.
 *
 * Why a lexicon and not a capitalization rule: "Claim Status", "Service
 * Date" and "Prior Authorization" are two capitalized words too, and a rule
 * that read those as names would tokenize the document into noise. A given
 * name from a known list, followed by a capitalized surname that is not a
 * common word, is a much narrower signal.
 *
 * DELIBERATELY ABSENT: given names that are also ordinary English words or
 * month names — May, June, April, August, Will, Mark, Bill, Art, Guy, Pat,
 * Rich, Frank, Chase, Page, Hope, Faith, Joy, Grace, Summer, Dawn, Sky,
 * Hunter, Carter, Mason, Cooper, Parker, Taylor, Jordan, Austin, Dallas,
 * Sterling, Royal, King, Prince, Major, Justice, Honor, Precious, Destiny,
 * Harmony, Melody, Ivy, Holly, Heather, Olive, Ruby, Amber, Crystal, Jade,
 * Iris, Violet, Rose, Daisy, Lily, Pearl, Autumn, Sage, River, Rain, Stone,
 * Ray, Don, Ken, Gene, Earl, Ernest, Frank. Their capitalized form starts
 * sentences and headings too often. A person with one of these names is
 * still found wherever they appear under a label, and everywhere else once
 * found (propagation).
 *
 * This is a recall aid, not a completeness claim: a name not on this list,
 * with no label, is not found.
 */
export const GIVEN_NAMES = Object.freeze([
  // Female
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen',
  'Lisa', 'Nancy', 'Betty', 'Sandra', 'Margaret', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle',
  'Carol', 'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura', 'Cynthia', 'Amy',
  'Kathleen', 'Angela', 'Shirley', 'Brenda', 'Emma', 'Anna', 'Pamela', 'Nicole', 'Samantha', 'Katherine',
  'Christine', 'Helen', 'Debra', 'Rachel', 'Carolyn', 'Janet', 'Maria', 'Catherine', 'Diane', 'Olivia',
  'Julie', 'Victoria', 'Kelly', 'Christina', 'Lauren', 'Joan', 'Evelyn', 'Judith', 'Andrea', 'Hannah',
  'Megan', 'Cheryl', 'Jacqueline', 'Martha', 'Madison', 'Teresa', 'Gloria', 'Sara', 'Janice', 'Ann',
  'Kathryn', 'Abigail', 'Sophia', 'Frances', 'Jean', 'Alice', 'Judy', 'Isabella', 'Julia', 'Beverly',
  'Denise', 'Marilyn', 'Danielle', 'Brittany', 'Diana', 'Natalie', 'Theresa', 'Charlotte',
  'Kayla', 'Alexis', 'Lori', 'Tiffany', 'Kristen', 'Tamara', 'Wendy', 'Tracy', 'Vanessa', 'Erin',
  'Jane', 'Joyce', 'Virginia', 'Ruth', 'Dorothy', 'Marie', 'Lois', 'Doris', 'Mildred', 'Phyllis',
  'Norma', 'Irene', 'Louise', 'Eleanor', 'Lillian', 'Florence', 'Gladys', 'Edna', 'Ethel', 'Thelma',
  'Carmen', 'Rosa', 'Ana', 'Lucia', 'Sofia', 'Valentina', 'Camila', 'Gabriela', 'Daniela', 'Mariana',
  'Guadalupe', 'Yolanda', 'Esperanza', 'Leticia', 'Veronica', 'Adriana', 'Alejandra', 'Claudia', 'Monica', 'Silvia',
  'Chloe', 'Ava', 'Mia', 'Harper', 'Ella', 'Avery', 'Scarlett', 'Aria', 'Zoe', 'Nora',
  'Leah', 'Audrey', 'Claire', 'Lucy', 'Naomi', 'Aaliyah', 'Savannah', 'Brooklyn', 'Stella', 'Paisley',
  'Keisha', 'Latoya', 'Tanisha', 'Ebony', 'Shanice', 'Imani', 'Aisha', 'Fatima', 'Priya', 'Anjali',
  'Mei', 'Yuki', 'Min', 'Ji', 'Hana', 'Leila', 'Yasmin', 'Noor', 'Zara', 'Ingrid',
  'Joanne', 'Suzanne', 'Colleen', 'Maureen', 'Eileen', 'Kathy', 'Peggy', 'Sheila', 'Rita', 'Connie',
  'Marcia', 'Tina', 'Terri', 'Paula', 'Vicki', 'Stacy', 'Kristin', 'Heidi', 'Jill', 'Kim',
  // Male
  'James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Christopher',
  'Charles', 'Daniel', 'Matthew', 'Anthony', 'Donald', 'Steven', 'Paul', 'Andrew', 'Joshua', 'Kenneth',
  'Kevin', 'Brian', 'George', 'Timothy', 'Ronald', 'Edward', 'Jason', 'Jeffrey', 'Ryan', 'Jacob',
  'Gary', 'Nicholas', 'Eric', 'Jonathan', 'Stephen', 'Larry', 'Justin', 'Scott', 'Brandon', 'Benjamin',
  'Samuel', 'Gregory', 'Alexander', 'Patrick', 'Raymond', 'Jack', 'Dennis', 'Jerry', 'Tyler', 'Aaron',
  'Jose', 'Adam', 'Nathan', 'Henry', 'Douglas', 'Zachary', 'Peter', 'Kyle', 'Noah', 'Ethan',
  'Jeremy', 'Walter', 'Christian', 'Keith', 'Roger', 'Terry', 'Harold', 'Sean', 'Carl', 'Arthur',
  'Lawrence', 'Dylan', 'Jesse', 'Bryan', 'Joe', 'Billy', 'Bruce', 'Gabriel', 'Logan',
  'Albert', 'Willie', 'Alan', 'Eugene', 'Russell', 'Vincent', 'Philip', 'Bobby', 'Johnny', 'Bradley',
  'Roy', 'Ralph', 'Randy', 'Wayne', 'Howard', 'Fred', 'Louis', 'Harry', 'Clarence', 'Stanley',
  'Leonard', 'Norman', 'Herbert', 'Francis', 'Lloyd', 'Floyd', 'Leroy', 'Melvin', 'Chester', 'Clifford',
  'Juan', 'Carlos', 'Luis', 'Jorge', 'Miguel', 'Pedro', 'Manuel', 'Francisco', 'Alejandro', 'Diego',
  'Javier', 'Ricardo', 'Fernando', 'Roberto', 'Eduardo', 'Rafael', 'Sergio', 'Alberto', 'Mateo', 'Santiago',
  'Liam', 'Oliver', 'Elijah', 'Lucas', 'Aiden', 'Caleb', 'Owen', 'Wyatt', 'Isaac', 'Julian',
  'Levi', 'Isaiah', 'Josiah', 'Ezra', 'Silas', 'Elias', 'Miles', 'Declan', 'Theodore', 'Sebastian',
  'Jamal', 'Darnell', 'Tyrone', 'Deandre', 'Terrell', 'Marcus', 'Malik', 'Andre', 'Jerome', 'Cedric',
  'Mohammed', 'Muhammad', 'Ahmed', 'Omar', 'Ali', 'Hassan', 'Raj', 'Arjun', 'Vikram', 'Wei',
  'Hiroshi', 'Kenji', 'Takashi', 'Jin', 'Hyun', 'Minh', 'Duc', 'Sven', 'Lars',
  'Craig', 'Todd', 'Troy', 'Shane', 'Derek', 'Travis', 'Jared', 'Corey', 'Brett', 'Dustin',
  'Allen', 'Glenn', 'Dale', 'Marvin', 'Victor', 'Martin', 'Ernesto', 'Jimmy', 'Tony', 'Danny',
]);

export const GIVEN_NAME_SET = Object.freeze(new Set(GIVEN_NAMES));
